const { BrowserWindow } = require("electron");
const authService = require("../../services/auth-service");

let win = null;

function createAuthWindow(onAuthenticated) {
  destroyAuthWin();

  // Create the browser window.
  win = new BrowserWindow({
    width: 1000,
    height: 600
  });

  win.loadURL(authService.getAuthenticationURL());

  const {
    session: { webRequest }
  } = win.webContents;

  const filter = {
    urls: ["file:///auth0-callback*"]
  };

  webRequest.onBeforeRequest(filter, ({ url }) => {
    authService.loadTokens(url).then(() => {
      return destroyAuthWin(onAuthenticated);
    });
  });

  win.on("authenticated", () => {
    destroyAuthWin(onAuthenticated);
  });

  win.on("closed", () => {
    win = null;
  });
}

function destroyAuthWin(callback) {
  if (!win) return;
  callback().finally(() => {
    win.close();
    win = null;
  });
}

function createLogoutWindow() {
  return new Promise((resolve, reject) => {
    const logoutWindow = new BrowserWindow({
      show: false
    });

    logoutWindow.loadURL(authService.getLogOutUrl());

    logoutWindow.on("ready-to-show", () => {
      logoutWindow.close();
      authService
        .logout()
        .then(resolve)
        .catch(reject);
    });
  });
}

module.exports = {
  createAuthWindow,
  createLogoutWindow
};
