// @ts-check
const { relative } = require('path')
const { cwd, env } = require('process')

const getAvailablePort = require('get-port')
const { v4: generateUUID } = require('uuid')

const { NETLIFYDEVERR, NETLIFYDEVWARN, chalk, log } = require('../../utils/command-helpers')
const { getPathInProject } = require('../settings')
const { startSpinner, stopSpinner } = require('../spinner')

const { DIST_IMPORT_MAP_PATH } = require('./consts')
const headers = require('./headers')
const { getInternalFunctions } = require('./internal')
const { EdgeFunctionsRegistry } = require('./registry')

const headersSymbol = Symbol('Edge Functions Headers')

const LOCAL_HOST = '127.0.0.1'

const getDownloadUpdateFunctions = () => {
  let spinner

  const onAfterDownload = () => {
    stopSpinner({ spinner })
  }

  const onBeforeDownload = () => {
    spinner = startSpinner({ text: 'Setting up the Edge Functions environment. This may take a couple of minutes.' })
  }

  return {
    onAfterDownload,
    onBeforeDownload,
  }
}

const handleProxyRequest = (req, proxyReq) => {
  Object.entries(req[headersSymbol]).forEach(([header, value]) => {
    proxyReq.setHeader(header, value)
  })
}

const initializeProxy = async ({ config, configPath, getUpdatedConfig, settings }) => {
  const { functions: internalFunctions, importMap, path: internalFunctionsPath } = await getInternalFunctions()
  const { port: mainPort } = settings
  const userFunctionsPath = config.build.edge_functions
  const isolatePort = await getAvailablePort()

  // Initializes the server, bootstrapping the Deno CLI and downloading it from
  // the network if needed. We don't want to wait for that to be completed, or
  // the command will be left hanging.
  const server = prepareServer({
    config,
    configPath,
    directories: [internalFunctionsPath, userFunctionsPath].filter(Boolean),
    getUpdatedConfig,
    importMaps: [importMap].filter(Boolean),
    internalFunctions,
    port: isolatePort,
  })
  const hasEdgeFunctions = userFunctionsPath !== undefined || internalFunctions.length !== 0

  return async (req) => {
    if (req.headers[headers.Passthrough] !== undefined || !hasEdgeFunctions) {
      return
    }

    const { registry } = await server

    await registry.initialize()

    const url = new URL(req.url, `http://${LOCAL_HOST}:${mainPort}`)
    const { functionNames, orphanedDeclarations } = await registry.matchURLPath(url.pathname)

    // If the request matches a config declaration for an Edge Function without
    // a matching function file, we warn the user.
    orphanedDeclarations.forEach((functionName) => {
      log(
        `${NETLIFYDEVWARN} Request to ${chalk.yellow(
          url.pathname,
        )} matches declaration for edge function ${chalk.yellow(
          functionName,
        )}, but there's no matching function file in ${chalk.yellow(
          relative(cwd(), userFunctionsPath),
        )}. Please visit ${chalk.blue('https://ntl.fyi/edge-create')} for more information.`,
      )
    })

    if (functionNames.length === 0) {
      return
    }

    req[headersSymbol] = {
      [headers.Functions]: functionNames.join(','),
      [headers.PassHost]: `${LOCAL_HOST}:${mainPort}`,
      [headers.Passthrough]: 'passthrough',
      [headers.RequestID]: generateUUID(),
    }

    return `http://${LOCAL_HOST}:${isolatePort}`
  }
}

const isEdgeFunctionsRequest = (req) => req[headersSymbol] !== undefined

const prepareServer = async ({
  config,
  configPath,
  directories,
  getUpdatedConfig,
  importMaps,
  internalFunctions,
  port,
}) => {
  const bundler = await import('@netlify/edge-bundler')
  const distImportMapPath = getPathInProject([DIST_IMPORT_MAP_PATH])
  const runIsolate = await bundler.serve({
    ...getDownloadUpdateFunctions(),
    debug: env.NETLIFY_DENO_DEBUG === 'true',
    distImportMapPath,
    formatExportTypeError: (name) =>
      `${NETLIFYDEVERR} ${chalk.red('Failed')} to load Edge Function ${chalk.yellow(
        name,
      )}. The file does not seem to have a function as the default export.`,
    formatImportError: (name) => `${NETLIFYDEVERR} ${chalk.red('Failed')} to run Edge Function ${chalk.yellow(name)}:`,
    importMaps,
    port,
  })
  const registry = new EdgeFunctionsRegistry({
    bundler,
    config,
    configPath,
    directories,
    getUpdatedConfig,
    internalFunctions,
    runIsolate,
  })

  return { registry, runIsolate }
}

module.exports = { handleProxyRequest, initializeProxy, isEdgeFunctionsRequest }