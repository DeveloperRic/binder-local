// const isSquirrelStartup = require("electron-squirrel-startup");
// if (isSquirrelStartup) return;
require("dotenv").config();

const { app, Tray, Menu, ipcMain, shell, dialog } = require("electron");

// if (isSquirrelStartup) return app.quit();
const { autoUpdater } = require("electron-updater");
autoUpdater.checkForUpdatesAndNotify();
autoUpdater.logger = require("electron-log");
autoUpdater.logger.transports.file.level = "info";

const fs = require("fs");
const setupPug = require("electron-pug");
const mongoose = require("mongoose");

const { DEV_MODE, resolveDir, checkAutoLauncher } = require("./prodVariables");
const { info: logInfo, error: logError, debug: logDebug } = require("./logger");
// console.log = (...msgs) => {
//   if (DEV_MODE) {
//     logDebug(msgs.join(" "));
//   } else {
//     logInfo("info", msgs.join(" "));
//   }
// };
// console.error = (...msgs) => {
//   logError("error", msgs.join(" "));
// };
logInfo("wtf is going on");

const { getMongodbKey } = require("./security/keyManagement");
const { appendSecurityKey } = require("./security/storeSecure");
const { createAuthWindow } = require("./frontend/app/auth-process");
const {
  createAppWindow,
  appWindowVisible,
  showAppWindow,
  hideAppWindow,
  sendMessage
} = require("./frontend/app/app-process");
const { load: loadLocalSettings } = require("./services/localSettings");
const authService = require("./services/auth-service");
const uploadService = require("./services/upload-service");
const spiderService = require("./services/spider-service");
const downloadService = require("./services/download-service");
const internetService = require("./services/internet-service");
const User = require("./model/user");
const Plan = require("./model/plan");

let initialised = false;

// TODO fix problems listed in VSCode problems tab (ctrl+`)
// TODO delete files in /data before publishing updates

function showWindow(onAuthenticated) {
  authService
    .refreshTokens()
    .then(() => onAuthenticated())
    .catch(() => {
      createAuthWindow(onAuthenticated);
    });
}

/**
 * @type {Tray}
 */
let tray;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", () => {
  declareTrayIcon();
  let errorsOcurred = false;
  mongoose.set("useFindAndModify", false);
  loadLocalSettings()
    .then(({ autolaunch: { enabled: shouldEnable } }) => {
      console.log("Local settings loaded");
      checkAutoLauncher(shouldEnable)
        .then(() => console.log("AutoLaunch status checked"))
        .catch(err => {
          console.error("Failed to check AutoLaunch status", err);
        });
      mongoose
        .connect(getMongodbKey(), {
          useNewUrlParser: true,
          useCreateIndex: true
        })
        .then(() => console.log("Connected to MongoDB database"))
        .then(startup2)
        .catch(err => {
          console.error("Failed to connect to database", err);
          connectionCallback(false, true);
          errorsOcurred = true;
        });
    })
    .catch(err => {
      console.error("!!! Failed to load local settings", err);
      errorsOcurred = true;
    });
  function startup2() {
    setupPug({ pretty: true }, {})
      .then(pug => {
        pug.on("error", err => {}); // console.error("electron-pug error", err)
        showWindow(() => {
          return new Promise((resolve, reject) => {
            declareIpcChannels();
            getUser((user, err1) => {
              startServices(user, err2 => {
                if (!err1 && !err2) {
                  console.log("\n=[ Binder has started ]=\n");
                } else {
                  errorsOcurred = true;
                  if (err1) console.error(err1);
                  if (err2) console.error(err2);
                  console.log("\n![ Some errors occured ]!\n");
                }
                // if (!showAppWindow()) {
                //   createFrontend();
                // }
                initialised = true;
                if (!tray) declareTrayIcon();
                if (!errorsOcurred) {
                  updateTrayTitle(" is running");
                } else {
                  updateTrayTitle(" is broken :(", false);
                }
                updateTrayMenu(!errorsOcurred);
                updateTrayIcon(!errorsOcurred);
                createFrontend();
                resolve();
              });
            });
          });
        });
      })
      .catch(err => console.error("Could not initiate 'electron-pug'", err));
  }
});

// Quit when all windows are closed.
// app.on("window-all-closed", () => {
//   app.quit();
// });
app.on("before-quit", () => {
  app.isQuiting = true;
});

function connectionCallback(connected, previous) {
  if (!initialised || connected == previous) return;
  updateTrayTitle(null, connected);
  updateTrayMenu(connected);
  updateTrayIcon(connected);
  sendMessage("client-internet-check", connected);
}

function createFrontend() {
  createAppWindow(() => {
    tray = null;
  }, restart);
}

function restart() {
  app.relaunch();
  quit();
}

function quit() {
  app.isQuiting = true;
  app.quit();
}

function declareTrayIcon() {
  tray = new Tray(`${__dirname}/frontend/img/tray-loading.png`); //32x32
  tray.on("click", onTrayClick);
  updateTrayTitle(" is starting");
  tray.setHighlightMode("always");
  updateTrayMenu();
  console.log("Declared tray icon");
}

function onTrayClick(onlyOpen) {
  if (!initialised) return;
  if (!onlyOpen && appWindowVisible()) {
    hideAppWindow();
  } else if (!showAppWindow()) {
    createFrontend();
  }
}

function onTrayCheckUpdates() {
  //TODO check for updates
  dialog.showMessageBox(null, {
    message: "This feature is still in development."
  });
}

function updateTrayIcon(
  connected = true,
  uploading = false,
  downloading = false
) {
  tray.setImage(getTrayIconPath(connected, uploading, downloading));
}

function getTrayIconPath(
  connected = true,
  uploading = false,
  downloading = false
) {
  let path = `${__dirname}/frontend/img/tray-`;
  if (!initialised) path += "loading.png";
  else {
    if (connected) {
      if (uploading) path += "upload.png";
      else if (downloading) path += "download.png";
      else path += "icon.png";
    } else path += "offline.png";
  }
  return path;
}

var oldTrayState;
function updateTrayTitle(state, connected = true) {
  let title = "Binder" + (state || oldTrayState);
  if (!connected) title += "\n( Offline )";
  tray.setToolTip(title);
  if (state) oldTrayState = state;
}

function updateTrayMenu(
  connected = true,
  uploading = false,
  downloading = false
) {
  let template = [
    {
      label: `Binder${connected ? "" : " ( offline ) !"}`,
      enabled: false,
      icon: getTrayIconPath(connected, uploading, downloading)
    },
    {
      label: "Uploading files...",
      enabled: false,
      visible: uploading
    },
    {
      label: "Downloading files...",
      enabled: false,
      visible: downloading
    },
    { type: "separator", visible: uploading || downloading },
    {
      label: "Open Dashboard",
      click: () => onTrayClick(true),
      enabled: initialised
    },
    { type: "separator" },
    {
      label: "About Binder",
      click: () => shell.openExternal("https://binderapp.xyz")
    },
    {
      label: "Check for updates",
      click: onTrayCheckUpdates,
      enabled: initialised && connected
    },
    { type: "separator" },
    {
      label: "Restart",
      enabled: initialised,
      click: () => {
        dialog.showMessageBox(
          null,
          {
            type: "info",
            buttons: ["Cancel", "Restart"],
            defaultId: 0,
            title: "Binder",
            message: "Restart Binder?",
            detail:
              "If a current upload/download is in progress, they will need to settle before the restart will occur."
          },
          res => {
            if (res == 1) {
              uploadService
                .pause()
                .then(() => {
                  downloadService
                    .pause()
                    .then(() => {
                      restart();
                    })
                    .catch(err => console.error(err));
                })
                .catch(err => console.error(err));
            }
          }
        );
      }
    },
    {
      label: "Quit",
      click: () => {
        dialog.showMessageBox(
          null,
          {
            type: "info",
            buttons: ["Cancel", "Quit"],
            defaultId: 0,
            title: "Binder",
            message: "Quit Binder?",
            detail:
              "If a current upload/download is in progress, they might need to settle before Binder will exit."
          },
          res => {
            if (res == 1) {
              uploadService
                .pause()
                .then(() => {
                  downloadService
                    .pause()
                    .then(() => {
                      quit();
                    })
                    .catch(err => console.error(err));
                })
                .catch(err => console.error(err));
            }
          }
        );
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function declareIpcChannels() {
  ipcMain.on("upload-service", (event, arg) => {
    event.returnValue = uploadService;
  });
  ipcMain.on("download-service", (event, arg) => {
    event.returnValue = downloadService;
  });
  ipcMain.on("spider-check-folder", (event, path) => {
    event.returnValue = spiderService.directoryIsSelected(path);
  });
  ipcMain.on("spider-check-file", (event, path) => {
    event.returnValue = spiderService.fileIsSelected(path);
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
      return event.reply(
        "spider-select-file-err",
        new Error("arg must include 'path' and 'include'")
      );
    }
    spiderService
      .selectFile(arg.path, arg.include)
      .then(() => {
        event.reply("spider-select-file-res", true);
      })
      .catch(err => {
        console.error(err);
        event.reply("spider-select-file-err", err);
      });
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
    event.returnValue = uploadService.getCurrentSchedule();
  });
  uploadService.setUploadHandlers({
    resume: schedule => {
      console.log("==== emitting resume ====");
      sendMessage("upload-resume", schedule);
      setTimeout(() => {
        updateTrayIcon(undefined, true);
        updateTrayMenu(undefined, true);
      }, 2000);
    },
    pause: () => {
      sendMessage("upload-paused");
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 2000);
    },
    progress: (fileDat, partNumber) => {
      sendMessage("upload-progress", fileDat, partNumber);
    },
    success: fileDat => {
      console.log("==== upload success ====");
      sendMessage("upload-success", fileDat);
    },
    failed: fileDat => {
      console.log("==== upload failed ====");
      sendMessage("upload-failed", fileDat);
    },
    allUploaded: schedule => {
      console.log("\nUpload [all done]\n");
      console.log("==== upload all-done ====");
      sendMessage("upload-all-done", schedule);
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 2000);
    },
    allFailed: schedule => {
      console.log("\nUpload [all failed!]\n");
      console.log("==== upload all-failed ====");
      sendMessage("upload-all-failed", schedule);
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 2000);
    }
  });
  //
  // ------ download service
  //
  ipcMain.on("download-request", (event, ...args) => {
    downloadService
      .requestDownload(...args)
      .then(downloadId => {
        sendMessage("download-request-res", downloadId);
        console.log("downloadId=" + downloadId);
      })
      .catch(err => {
        sendMessage("download-request-err", err);
        console.log(err);
      });
  });
  ipcMain.on("download-cancel", () => {
    downloadService
      .cancelDownload()
      .then(() => {
        sendMessage("download-cancel-res");
      })
      .catch(err => {
        sendMessage("download-cancel-err", err);
        console.log(err);
      });
  });
  ipcMain.on("download-event-handlers", (event, arg) => {
    downloadService.setDownloadHandlers(arg);
  });
  ipcMain.on("download-status", (event, arg) => {
    sendMessage("download-resume", uploadService.getCurrentSchedule());
    event.returnValue = uploadService.getCurrentSchedule();
  });
  downloadService.setDownloadHandlers({
    resume: progress => {
      console.log("==== download resume ====");
      sendMessage("download-resume", progress);
      setTimeout(() => {
        updateTrayIcon(undefined, undefined, true);
        updateTrayMenu(undefined, undefined, true);
      }, 3000);
    },
    paused: () => {
      sendMessage("download-paused");
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 3000);
    },
    captured: fileDat => {
      sendMessage("download-captured", fileDat);
    },
    decrypted: fileDat => {
      console.log("==== download success ====");
      sendMessage("download-success", fileDat);
    },
    failed: fileDat => {
      console.log("==== download failed ====");
      sendMessage("download-failed", fileDat);
    },
    allDownloaded: progress => {
      console.log("==== download all-done ====");
      sendMessage("download-all-done", progress);
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 3000);
    },
    allFailed: progress => {
      console.log("==== download all-failed ====");
      sendMessage("download-all-failed", progress);
      setTimeout(() => {
        updateTrayIcon();
        updateTrayMenu();
      }, 3000);
    }
  });

  console.log("Declared ipc channels");
}

function getUser(next) {
  let profile = authService.getProfile();
  User.findOne({ email: profile.email }, { _id: 1, plan: 1 }, (err, user) => {
    if (err) return next(null, err);
    if (user) {
      User.updateOne(
        { _id: user._id },
        { email_verified: profile.email_verified },
        err => {
          if (err) return next(null, err);
          console.log("Got user (verified=" + profile.email_verified + ")");
          next(user);
        }
      );
    } else {
      user = {
        email: profile.email,
        email_verified: profile.email_verified,
        profile: {
          nickname: profile.nickname,
          picture: profile.picture
        },
        billing: {
          firstName: profile.nickname
        }
      };
      User.create(appendSecurityKey(user), (err, _user) => {
        if (err) return next(null, err);
        console.log("Created user");
        user._id = _user._id;
        next(user);
      });
    }
  }).lean(true);
}

function startServices({ _id: uid, plan: planId }, next) {
  Plan.findById(planId, { expired: 1 })
    .then(plan => {
      fs.mkdirSync(resolveDir("data"), { recursive: true });
      if (!plan || plan.expired) {
        console.log(
          "User's plan has expired, upload, download & spider services not started"
        );
        return next();
      }
      //ObjectId validator regex /^[a-fA-F0-9]{24}$/
      uploadService
        .init(
          uid,
          plan._id,
          downloadService.isPaused,
          downloadService.isWaiting,
          downloadService.resume
        )
        .then(() => {
          console.log("Upload service started");
          downloadService
            .init(
              uid,
              plan._id,
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
              });
              //-----------------------------
              spiderService
                .startSpider(uid, uploadService)
                .then(() => {
                  console.log("Spider started successfully");
                  internetService.start(connectionCallback);
                  console.log("Internet-service started");
                  next();
                })
                .catch(err => next(err));
            })
            // nothing is allowed to go wrong here!
            .catch(err => next(err));
        })
        // nothing is allowed to go wrong here!
        .catch(err => next(err));
    })
    .catch(err => next(err));
}
