import { join, resolve } from 'pathe'
import * as vite from 'vite'
import vuePlugin from '@vitejs/plugin-vue'
import viteJsxPlugin from '@vitejs/plugin-vue-jsx'
import type { ServerOptions } from 'vite'
import { logger } from '@nuxt/kit'
import { getPort } from 'get-port-please'
import { joinURL, withoutLeadingSlash } from 'ufo'
import defu from 'defu'
import type { OutputOptions } from 'rollup'
import { defineEventHandler } from 'h3'
import { cacheDirPlugin } from './plugins/cache-dir'
import type { ViteBuildContext, ViteOptions } from './vite'
import { devStyleSSRPlugin } from './plugins/dev-ssr-css'
import { viteNodePlugin } from './vite-node'

export async function buildClient (ctx: ViteBuildContext) {
  const clientConfig: vite.InlineConfig = vite.mergeConfig(ctx.config, {
    entry: ctx.entry,
    base: ctx.nuxt.options.dev
      ? joinURL(ctx.nuxt.options.app.baseURL.replace(/^\.\//, '/') || '/', ctx.nuxt.options.app.buildAssetsDir)
      : './',
    experimental: {
      renderBuiltUrl: (filename, { type, hostType }) => {
        if (hostType !== 'js' || type === 'asset') {
          // In CSS we only use relative paths until we craft a clever runtime CSS hack
          return { relative: true }
        }
        return { runtime: `globalThis.__publicAssetsURL(${JSON.stringify(filename)})` }
      }
    },
    define: {
      'process.server': false,
      'process.client': true,
      'module.hot': false
    },
    optimizeDeps: {
      entries: [ctx.entry]
    },
    resolve: {
      alias: {
        '#build/plugins': resolve(ctx.nuxt.options.buildDir, 'plugins/client'),
        '#internal/nitro': resolve(ctx.nuxt.options.buildDir, 'nitro.client.mjs')
      },
      dedupe: ['vue']
    },
    build: {
      sourcemap: ctx.nuxt.options.sourcemap.client ? ctx.config.build?.sourcemap ?? true : false,
      manifest: true,
      outDir: resolve(ctx.nuxt.options.buildDir, 'dist/client'),
      rollupOptions: {
        input: ctx.entry
      }
    },
    plugins: [
      cacheDirPlugin(ctx.nuxt.options.rootDir, 'client'),
      vuePlugin(ctx.config.vue),
      viteJsxPlugin(),
      devStyleSSRPlugin({
        srcDir: ctx.nuxt.options.srcDir,
        buildAssetsURL: joinURL(ctx.nuxt.options.app.baseURL, ctx.nuxt.options.app.buildAssetsDir)
      }),
      viteNodePlugin(ctx)
    ],
    appType: 'custom',
    server: {
      middlewareMode: true
    }
  } as ViteOptions)

  // In build mode we explicitly override any vite options that vite is relying on
  // to detect whether to inject production or development code (such as HMR code)
  if (!ctx.nuxt.options.dev) {
    clientConfig.server!.hmr = false
  }

  // We want to respect users' own rollup output options
  clientConfig.build!.rollupOptions = defu(clientConfig.build!.rollupOptions!, {
    output: {
      chunkFileNames: ctx.nuxt.options.dev ? undefined : withoutLeadingSlash(join(ctx.nuxt.options.app.buildAssetsDir, '[name].[hash].js')),
      entryFileNames: ctx.nuxt.options.dev ? 'entry.js' : withoutLeadingSlash(join(ctx.nuxt.options.app.buildAssetsDir, '[name].[hash].js'))
    } as OutputOptions
  }) as any

  if (clientConfig.server && clientConfig.server.hmr !== false) {
    const hmrPortDefault = 24678 // Vite's default HMR port
    const hmrPort = await getPort({
      port: hmrPortDefault,
      ports: Array.from({ length: 20 }, (_, i) => hmrPortDefault + 1 + i)
    })
    clientConfig.server = defu(clientConfig.server, <ServerOptions>{
      https: ctx.nuxt.options.devServer.https,
      hmr: {
        protocol: ctx.nuxt.options.devServer.https ? 'wss' : 'ws',
        port: hmrPort
      }
    })
  }

  // Add analyze plugin if needed
  if (ctx.nuxt.options.build.analyze) {
    clientConfig.plugins!.push(...await import('./plugins/analyze').then(r => r.analyzePlugin(ctx)))
  }

  await ctx.nuxt.callHook('vite:extendConfig', clientConfig, { isClient: true, isServer: false })

  if (ctx.nuxt.options.dev) {
    // Dev
    const viteServer = await vite.createServer(clientConfig)
    ctx.clientServer = viteServer
    await ctx.nuxt.callHook('vite:serverCreated', viteServer, { isClient: true, isServer: false })
    const viteMiddleware = defineEventHandler(async (event) => {
      // Workaround: vite devmiddleware modifies req.url
      const originalURL = event.req.url!
      if (!originalURL.startsWith('/__nuxt_vite_node__') && !originalURL.startsWith(clientConfig.base!)) {
        event.req.url = joinURL('/__url', originalURL)
      }
      await new Promise((resolve, reject) => {
        viteServer.middlewares.handle(event.req, event.res, (err: Error) => {
          event.req.url = originalURL
          return err ? reject(err) : resolve(null)
        })
      })
    })
    await ctx.nuxt.callHook('server:devHandler', viteMiddleware)

    ctx.nuxt.hook('close', async () => {
      await viteServer.close()
    })
  } else {
    // Build
    const start = Date.now()
    await vite.build(clientConfig)
    await ctx.nuxt.callHook('vite:compiled')
    logger.info(`Client built in ${Date.now() - start}ms`)
  }
}
