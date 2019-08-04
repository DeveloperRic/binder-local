// const isSquirrelStartup = require("electron-squirrel-startup");
// if (isSquirrelStartup) return;
require("dotenv").config();

const { app, Tray, Menu, ipcMain } = require("electron");

// if (isSquirrelStartup) return app.quit();
const { autoUpdater } = require("electron-updater");
autoUpdater.checkForUpdatesAndNotify();
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";

const { getMongodbKey } = require("./security/keyManagement");
const { appendSecurityKey } = require("./security/storeSecure");
const { resolveDir } = require("./prodVariables");
const { createAuthWindow } = require("./frontend/app/auth-process");
const {
  createAppWindow,
  appWindowVisible,
  showAppWindow,
  hideAppWindow,
  sendMessage
} = require("./frontend/app/app-process");
const authService = require("./services/auth-service");
const uploadService = require("./services/upload-service");
const spiderService = require("./services/spider-service");
const downloadService = require("./services/download-service");

const fs = require("fs");
const setupPug = require("electron-pug");
const mongoose = require("mongoose");
const AutoLaunch = require("auto-launch");

const User = require("./model/user");

var autoLauncher = new AutoLaunch({
  name: "Binder"
});
autoLauncher.enable();
autoLauncher
  .isEnabled()
  .then(isEnabled => {
    if (isEnabled) return;
    autoLauncher.enable();
  })
  .catch(err => {}); // TODO handle error

let initialised = false;

// TODO fix problems listed in VSCode problems tab (ctrl+`)
// TODO delete files in /data before publishing updates
// TODO tray icon should represent internet/upload/download status

function showWindow(onAuthenticated) {
  authService
    .refreshTokens()
    .then(() => onAuthenticated())
    .catch(() => {
      createAuthWindow(onAuthenticated);
    });
}

let tray;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  mongoose
    .connect(getMongodbKey(), {
      useNewUrlParser: true,
      useCreateIndex: true
    })
    .then(() => console.log("Connected to MongoDB database"))
    .catch(err => console.error("Failed to connect to database", err));
  mongoose.set("useFindAndModify", false);

  setupPug({ pretty: true }, {})
    .then(pug => {
      pug.on("error", err => {}); // console.error("electron-pug error", err)
      declareTrayIcon();
      showWindow(() => {
        return new Promise((resolve, reject) => {
          declareIpcChannels();
          getUser((user, err1) => {
            startServices(user, err2 => {
              if (!err1 && !err2) {
                console.log("\n=[ Binder has started ]=\n");
              } else {
                //TODO somehow notify the user of these
                if (err1) console.error(err1);
                if (err2) console.error(err2);
                console.log("\n![ Some errors occured ]!\n");
              }
              // if (!showAppWindow()) {
              //   createFrontend();
              // }
              initialised = true;
              if (!tray) declareTrayIcon();
              tray.setToolTip("Binder is running");
              createFrontend();
              resolve();
            });
          });
        });
      });
    })
    .catch(err => console.error("Could not initiate 'electron-pug'", err));
});

// Quit when all windows are closed.
// app.on("window-all-closed", () => {
//   app.quit();
// });
app.on("before-quit", () => {
  app.isQuiting = true;
});

function onTrayClick() {
  if (!initialised) return;
  if (appWindowVisible()) {
    hideAppWindow();
  } else if (!showAppWindow()) {
    createFrontend();
  }
}

function createFrontend() {
  createAppWindow(
    () => {
      tray = null;
    },
    callback => {
      app.relaunch();
      quit();
    }
  );
}

function quit() {
  app.isQuiting = true;
  app.quit();
}

function declareTrayIcon() {
  tray = new Tray(`${__dirname}/frontend/img/tray-icon.png`); //32x32
  tray.on("click", onTrayClick);
  tray.setToolTip("Binder is starting");
  tray.setHighlightMode("always");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Dashboard", click: onTrayClick },
      { label: "Quit Binder", click: quit }
    ])
  );
  console.log("Declared tray icon");
}

function declareIpcChannels() {
  ipcMain.on("upload-service", (event, arg) => {
    event.returnValue = uploadService;
  });
  ipcMain.on("download-service", (event, arg) => {
    event.returnValue = downloadService;
  });
  ipcMain.on("spider-select-folder", (event, arg) => {
    if (typeof arg.path === "undefined" || typeof arg.include === "undefined") {
      throw new Error("arg must include 'path' and 'include'");
    }
    spiderService.selectDirectory(arg.path, arg.include);
    event.returnValue = true;
  });
  ipcMain.on("spider-select-file", (event, arg) => {
    if (typeof arg.path === "undefined" || typeof arg.include === "undefined") {
      throw new Error("arg must include 'path' and 'include'");
    }
    spiderService.selectFile(arg.path, arg.include);
    event.returnValue = true;
  });
  ipcMain.on("spider-directoryStore", (event, arg) => {
    spiderService
      .readOnlyDirectoryStore()
      .then(directoryStore => {
        event.reply("spider-directoryStore-res", directoryStore);
      })
      .catch(err => {
        event.reply("spider-directoryStore-err", err);
      });
  });
  //
  // --------- upload service
  //
  ipcMain.on("upload-event-handlers", (event, arg) => {
    uploadService.setUploadHandlers(arg);
  });
  ipcMain.on("upload-status", (event, arg) => {
    sendMessage("upload-resume", uploadService.getCurrentSchedule());
    event.returnValue = uploadService.getCurrentSchedule();
  });
  uploadService.setUploadHandlers({
    resume: schedule => {
      // console.log("==== emitting resume ====");
      sendMessage("upload-resume", schedule);
    },
    progress: (fileDat, partNumber) => {
      sendMessage("upload-progress", fileDat, partNumber);
    },
    success: fileDat => {
      // console.log("==== emitting success ====");
      sendMessage("upload-success", fileDat);
    },
    failed: fileDat => {
      // console.log("==== emitting failed ====");
      sendMessage("upload-failed", fileDat);
    },
    allUploaded: schedule => {
      console.log("\nUpload [all done]\n");
      // console.log("==== emitting all-done ====");
      sendMessage("upload-all-uploaded", schedule);
    },
    allFailed: schedule => {
      console.log("\nUpload [all failed!]\n");
      // console.log("==== emitting all-failed ====");
      sendMessage("upload-all-failed", schedule);
    }
  });
  //
  // ------ download service
  //
  ipcMain.on("download-request", (event, ...args) => {
    downloadService
      .requestDownload(...args)
      .then(downloadId => {
        event.reply("download-request-res", downloadId);
        console.log(downloadId);
      })
      .catch(err => {
        event.reply("download-request-err", err);
        console.log(err);
      });
  });
  ipcMain.on("download-event-handlers", (event, arg) => {
    downloadService.setDownloadHandlers(arg);
  });
  // ipcMain.on("download-status", (event, arg) => {
  //   sendMessage("download-resume", uploadService.getCurrentSchedule());
  //   event.returnValue = uploadService.getCurrentSchedule();
  // });
  // downloadService.setDownloadHandlers({
  //   resume: schedule => {
  //     // console.log("==== emitting resume ====");
  //     sendMessage("upload-resume", schedule);
  //   },
  //   captured: (fileDat, partNumber) => {
  //     sendMessage("upload-progress", fileDat, partNumber);
  //   },
  //   released: fileDat => {
  //     // console.log("==== emitting success ====");
  //     sendMessage("upload-success", fileDat);
  //   },
  //   failed: fileDat => {
  //     // console.log("==== emitting failed ====");
  //     sendMessage("upload-failed", fileDat);
  //   },
  //   allUploaded: schedule => {
  //     // console.log("==== emitting all-done ====");
  //     sendMessage("upload-all-uploaded", schedule);
  //   },
  //   allFailed: schedule => {
  //     // console.log("==== emitting all-failed ====");
  //     sendMessage("upload-all-failed", schedule);
  //   }
  // });
  //
  console.log("Declared ipc channels");
}

function getUser(next) {
  let profile = authService.getProfile();
  User.findOne(
    { email: profile.email },
    { _id: 1, "plan.expired": 1, "plan.blocks": 1 },
    (err, user) => {
      if (err) return next(null, err);
      if (user) {
        console.log("Got user");
        next(user);
      } else {
        user = {
          email: profile.email,
          email_verified: profile.email_verified,
          profile: {
            nickname: profile.nickname,
            picture: profile.picture
          }
        };
        User.create(appendSecurityKey(user), (err, _user) => {
          if (err) return next(null, err);
          console.log("Got user");
          user._id = _user._id;
          next(user);
        });
      }
    }
  ).lean(true);
}

function startServices({ _id: uid, plan }, next) {
  fs.mkdirSync(resolveDir("data"), { recursive: true });
  if (plan && plan.expired) {
    console.log("User's plan has expired, upload+spider services not started");
    return next();
  }
  //ObjectId validator regex /^[a-fA-F0-9]{24}$/
  uploadService
    .init(
      uid,
      downloadService.isPaused,
      downloadService.isWaiting,
      downloadService.resume
    )
    .then(() => {
      console.log("Upload service started");
      downloadService
        .init(
          uid,
          uploadService.isPaused,
          uploadService.isWaiting,
          uploadService.resume
        )
        .then(() => {
          console.log("Download service started");
          //-----------------------------
          uploadService
            .pause()
            .finally(() => console.log("Upload service resuming"))
            .then(uploadService.resume)
            .catch(err => {
              console.error(
                "\n",
                "Upload service blocked the resume. Possible plan expiry\n",
                err,
                "\n"
              );
            });
          //-----------------------------
          console.log("Download service resuming soon..");
          setImmediate(() => {
            if (uploadService.isPaused()) {
              downloadService
                .pause()
                .finally(() => console.log("Download service resuming"))
                .then(downloadService.resume)
                .catch(err => {
                  console.error(
                    "\n",
                    "Download service blocked the resume. Upload-service might be busy\n",
                    err,
                    "\n"
                  );
                });
            } else {
              console.log(
                "Refused to resume download service; upload-service is busy"
              );
            }
          });
          //-----------------------------
          spiderService
            .startSpider(uid, uploadService)
            .then(() => {
              console.log("Spider started successfully");
              next();
            })
            .catch(err => next(err));
        })
        // nothing is allowed to go wrong here!
        .catch(err => next(err));
    })
    // nothing is allowed to go wrong here!
    .catch(err => next(err));
}
