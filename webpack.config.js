//@ts-check

'use strict';

const path = require('path');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
  // the vscode-module is created on-the-fly and must be excluded
  vscode: 'commonjs vscode',
  // Node builtins - ensure runtime requires are left as commonjs imports
  fs: 'commonjs fs',
  path: 'commonjs path',
  os: 'commonjs os',
  child_process: 'commonjs child_process',
  crypto: 'commonjs crypto',
  stream: 'commonjs stream',
  zlib: 'commonjs zlib',
  // Dev-only / optional tooling that should NOT be bundled into the runtime.
  // These are used conditionally (dynamic require / try/catch) and are provided
  // as externals so the production bundle doesn't include heavy dev tooling.
  typescript: 'commonjs typescript'
  ,
  'optional-tiktoken-adapter': 'commonjs optional-tiktoken-adapter'
  // Note: If you add other optional adapters that must remain external, list
  // them here as 'moduleName': 'commonjs moduleName'. Modules marked external
  // will be required at runtime (if present) and should be installed by the
  // user if they want the adapter behavior. See README for guidance.
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];