// Web export under a sub-path (GitHub Pages project site): SITE_BASE_PATH=/cyfouri npx expo export -p web.
// Expo then serves every route and asset (and EXPO_BASE_URL: data/, vendor/) under that path.
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    ...(process.env.SITE_BASE_PATH ? { baseUrl: process.env.SITE_BASE_PATH } : {}),
  },
});
