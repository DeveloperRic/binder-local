const path = require("path");
const { app } = require("electron");
const autoLauncher = new (require("auto-launch"))({
  name: "Binder",
  isHidden: true
});
require("dotenv").config();

//TODO always change this to FALSE when publishing
const DEV_MODE = false;
//TODO allow restarting app in production-dev-mode
const PROD_DEV_MODE = DEV_MODE || false;

/**
 * Resolves the path to a directory in the standard system locations
 */
function resolveDir(dir) {
  return path.resolve(DEV_MODE ? __dirname : app.getPath("userData"), dir);
}

/**
 * Ensures AutoLaunch status matches the provided setting
 * @param {boolean} shouldEnable 
 */
function checkAutoLauncher(shouldEnable) {
  return new Promise((resolve, reject) => {
    autoLauncher
      .isEnabled()
      .then(isEnabled => {
        if (!isEnabled && shouldEnable) {
          autoLauncher
            .enable()
            .then(resolve)
            .catch(reject);
        } else if (isEnabled && !shouldEnable) {
          autoLauncher
            .disable()
            .then(resolve)
            .catch(reject);
        }
      })
      .catch(reject);
  });
}

module.exports = {
  DEV_MODE,
  PROD_DEV_MODE,
  srcDir: __dirname,
  resolveDir,
  checkAutoLauncher,
  API_DOMAIN: DEV_MODE
    ? "http://localhost:3000"
    : process.env.BINDER_API_DOMAIN
};

//build iconURL http://www.iconj.com/ico/h/p/hpwvy4b6kc.ico
