const { BrowserWindow, Menu } = require("electron");
const authService = require("../../services/auth-service");

let win = null;
let closing = false;

function createAuthWindow(onAuthenticated) {
  destroyAuthWin();

  // Create the browser window.
  closing = false;

  win = new BrowserWindow({
    width: 1000,
    height: 600
  });

  win.setMenu(
    Menu.buildFromTemplate([
      {
        label: "Go Back",
        click: () => win.webContents.goBack()
      },
      {
        label: "Cancel",
        click: () => destroyAuthWin(() => onAuthenticated(false))
      }
    ])
  );

  win.loadURL(authService.getAuthenticationURL());

  const {
    session: { webRequest }
  } = win.webContents;

  const filter = {
    urls: ["file:///auth0-callback*"]
  };

  webRequest.onBeforeRequest(filter, ({ url }) => {
    authService.loadTokens(url).then(() => {
      return destroyAuthWin(() => onAuthenticated(true));
    });
  });

  // win.on("authenticated", () => {
  //   destroyAuthWin(() => onAuthenticated(true));
  // });

  win.on("closed", () => {
    win = null;
    if (!closing) {
      onAuthenticated(false);
    }
  });
}

function destroyAuthWin(callback) {
  if (!win) return;
  win.hide();
  new Promise(async resolve => {
    if (callback) {
      let p = callback();
      if (p instanceof Promise) {
        try {
          await p;
        } catch (err) {
          console.error(err);
        }
      }
    }
    resolve();
  })
    .finally(() => {
      closing = true;
      win.close();
      win = null;
    })
    .catch(err => console.error(err));
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
