// Metro config: Expo defaults plus one fix for ECharts.
// echarts and zrender ship their own tslib whose "modules/index.js" re-exports a CommonJS default that
// Metro's ESM interop leaves undefined; the pure-ESM build next to it (tslib.es6.js) has the same helpers.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'tslib') {
    const resolved = context.resolveRequest(context, 'tslib/package.json', platform);
    return { type: 'sourceFile', filePath: path.join(path.dirname(resolved.filePath), 'tslib.es6.js') };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
