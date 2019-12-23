// folders ctrl
app.controller("foldersCtrl", function($scope, $rootScope, $interval) {
  const pathParse = require("path-parse");
  const G = $rootScope.G;
  const { normalisePath } = G.require("services/coordination");
  const File = G.clientModels.File;
  const Block = G.clientModels.Block;
  const Download = G.clientModels.Download;

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting",
    checkArgs: () => {
      if (G.stageStack.switchArgs.folders) {
        if (G.stageStack.switchArgs.folders.includes("browse")) {
          G.switchStage("explore");
        }
      }
    }
  });

  var updates = ($scope.updates = {
    isLive: true,
    lastUpdate: -1,
    formattedLastUpdate: "never",
    task: null,
    setUpdating: isUpdating => {
      $interval.cancel(updates.task);
      if (!isUpdating) {
        updates.lastUpdate = Date.now();
        updates.formattedLastUpdate = "Just now";
        updates.task = $interval(() => {
          let dif = Date.now() - updates.lastUpdate;
          let num;
          let word;
          updates.isLive = dif < 60000;
          if (dif < 60000) {
            num = Math.floor(dif / 1000);
            word = "second";
          } else if (dif < 36000000) {
            num = Math.floor(dif / 60000);
            word = "minute";
          } else {
            num = Math.floor(dif / 36000000);
            word = "hour";
          }
          if (num > 1) word += "s";
          updates.formattedLastUpdate = `${num} ${word} ago`;
        }, 1000);
        return;
      }
      updates.formattedLastUpdate = "loading";
      updates.task = $interval(() => {
        if (updates.formattedLastUpdate.endsWith("...")) {
          updates.formattedLastUpdate = "loading";
        } else {
          updates.formattedLastUpdate += ".";
        }
      }, 400);
    }
  });

  let directoryListResponse = {
    allow: false
  };
  G.ipcRenderer.on("spider-directoryStore-err", (event, arg) => {
    if (!directoryListResponse.allow) return;
    directoryListResponse.allow = false;
    if (arg) directoryListResponse.reject(["An error occured", arg]);
    else directoryListResponse.reject(["Unknown error occured"]);
  });
  G.ipcRenderer.on("spider-directoryStore-res", (event, directoryStore) => {
    if (!directoryListResponse.allow) return;
    directoryListResponse.allow = false;
    if (!directoryStore) {
      return directoryListResponse.reject([
        "DirStore didn't return anything",
        directoryStore
      ]);
    }
    console.log(directoryStore);
    const directories = [];
    directoryStore.active.forEach(directory => {
      directories.push({
        path: directory.path,
        name: smallerPath(normalisePath(directory.path), 25),
        ignored: directory.files
          .filter(f => f.ignore)
          .map(f => {
            let filePath = pathParse(f.path);
            return {
              path: f.path,
              name: filePath.name + filePath.ext
            };
          })
      });
    });
    directoryStore.ignore.forEach(directory => {
      let existingDir = directories.find(d => d.path == directory.path);
      if (existingDir) {
        existingDir.ignored.splice(0, 0, {
          path: directory.path,
          name: pathParse(directory.path).name
        });
      }
    });
    let parents = new Map();
    for (let i in directories) {
      let directory = directories[i];
      let topParent = "";
      for (let j in directories) {
        let dir = directories[j];
        if (dir.path == directory.path) continue;
        if (directory.path.startsWith(dir.path)) {
          if (!topParent || dir.path.length < topParent.length) {
            topParent = dir.path;
          }
        }
      }
      let isOwnParent = topParent == "";
      if (isOwnParent) topParent = directory.path;
      if (parents.has(topParent)) {
        if (!isOwnParent) {
          parents.get(topParent).push(directory.path);
        }
      } else {
        if (isOwnParent) {
          parents.set(topParent, []);
        } else {
          parents.set(topParent, [directory.path]);
        }
      }
    }
    let groupedDirs = [];
    let parentsIterator = parents.entries();
    let group;
    while ((group = parentsIterator.next().value)) {
      const parentPath = group[0];
      const parent = directories.find(dir => dir.path == parentPath);
      if (!parent) throw new Error("Bad grouping algorithm");
      parent.subFolders = [];
      group[1].forEach(childPath => {
        let child = directories.find(dir => dir.path == childPath);
        if (!child) throw new Error("Bad grouping algorithm");
        parent.subFolders.push(child);
      });
      groupedDirs.push(parent);
    }
    folders.list = groupedDirs;
    console.log(folders.list);
    folders.status = "";
    updates.setUpdating(false);
    directoryListResponse.resolve();
    folders.loadTask = $interval(
      () => {
        if (folders.autoLoadCount++ < 5) {
          folders.load();
        }
      },
      60000,
      1
    );
  });

  var folders = ($scope.folders = {
    status: "waiting",
    list: [],
    addStatus: "",
    addFolderPath: "",
    loadTask: null,
    autoLoadCount: 0,
    showAll: false,
    load: () => {
      return new Promise((resolve, reject) => {
        $interval.cancel(folders.loadTask);
        updates.setUpdating(true);
        folders.status = "loading";
        directoryListResponse = {
          allow: true,
          resolve,
          reject
        };
        $scope.$$postDigest(() => {
          $interval(
            () => {
              if (!directoryListResponse.allow) return;
              directoryListResponse.allow = false;
              reject(["DirStore took too long to respond"]);
            },
            10000,
            1
          );
          G.ipcRenderer.send("spider-directoryStore");
        });
      });
    },
    toggleExpanded: folder => {
      folder.expanded = !folder.expanded;
    },
    startAdd: () => {
      if (folders.addStatus != "") return;
      folders.addFolderPath = "";
      folders.addStatus = "input";
    },
    cancelAdd: () => {
      if (folders.addStatus == "") return;
      folders.addFolderPath = "";
      folders.addStatus = "";
    },
    chooseFolder: () => {
      let selection = G.remote.dialog.showOpenDialog(
        G.remote.getCurrentWindow(),
        {
          title: "Start backing up a folder",
          buttonLabel: "Choose folder",
          properties: ["openDirectory"]
        }
      );
      if (selection) {
        folders.addFolderPath = selection[0];
      }
    },
    finishAdd: () => {
      if (!folders.addFolderPath) {
        return G.notifyError("Please select a folder");
      }
      folders.addStatus = "adding";
      setImmediate(() => {
        G.ipcRenderer.sendSync("spider-select-folder", {
          path: folders.addFolderPath,
          include: true
        });
        folders.addStatus = "";
        folders.load();
      });
    },
    removeFolder: folder => {
      if (!folder || !folder.path) {
        return G.notifyError("Cannot remove folder");
      }
      G.notifyInfo(
        "Are you sure you want to remove this folder?",
        false,
        confirmed => {
          if (!confirmed) return;
          folder.status = "loading";
          setImmediate(() => {
            G.ipcRenderer.sendSync("spider-select-folder", {
              path: folder.path,
              include: false
            });
            folder.status = "";
            folders.load();
          });
        },
        true
      );
    },
    viewStats: folder => {
      G.switchStage("stats", folder.path);
    }
  });

  var history = ($scope.history = {
    status: "waiting",
    list: [],
    loadTask: null,
    autoLoadCount: 0,
    load: () => {
      return new Promise((resolve, reject) => {
        let dateLowerBound = Date.now() - 30 * 24 * 60 * 60 * 1000;
        let doneFiles, doneBlocks, doneDownloads;
        let items = [];
        history.status = "loading";
        updates.setUpdating(true);
        let processLogs = (logList, actionPrefix) => {
          logList.forEach(historyItem => {
            items.push({
              action: `${actionPrefix} : ${historyItem.reason}`,
              actor: historyItem.ipAddress,
              timestamp: new Date(historyItem.date)
            });
          });
        };
        let onFound = () => {
          items.sort((a, b) => b.timestamp - a.timestamp);
          items.forEach(item => {
            item.formattedDate = `${
              G.shortMonths[item.timestamp.getMonth()]
            } ${item.timestamp.getDate()}`;
          });
          history.list = items;
          history.status = "";
          updates.setUpdating(false);
          resolve();
          history.loadTask = $interval(
            () => {
              if (history.autoLoadCount++ < 5) {
                history.load();
              }
            },
            60000,
            1
          );
        };
        File.find(
          {
            owner: G.user._id,
            "log.latestSizeCalculationDate": {
              $gte: dateLowerBound
            }
          },
          {
            "log.detected": 1,
            "log.updateHistory.list": { $slice: 6 },
            "log.binnedHistory.list": { $slice: 6 },
            "log.restoredHistory.list": { $slice: 6 },
            "log.latestSizeCalculationDate": 1
          },
          (err, files) => {
            if (err) return reject(["Couldn't load folder history", err]);
            files.forEach(file => {
              items.push({
                action: "File detected in file system",
                timestamp: new Date(file.log.detected)
              });
              processLogs(file.log.updateHistory.list, "File updated");
              processLogs(file.log.binnedHistory.list, "File binned");
              processLogs(file.log.restoredHistory.list, "File restored");
              if (file.log.latestSizeCalculationDate) {
                items.push({
                  action: "File size re-calculated",
                  timestamp: new Date(file.log.latestSizeCalculationDate)
                });
              }
            });
            if ((doneFiles = true) && doneBlocks && doneDownloads) onFound();
          }
        )
          .sort({ "log.latestSizeCalculationDate": -1 })
          .limit(6);
        Block.find(
          {
            owner: G.user._id,
            "log.latestSizeCalculationDate": {
              $gte: dateLowerBound
            }
          },
          {
            "log.provisionedDate": 1,
            "log.blockBinnedHistory.list": { $slice: 6 },
            "log.blockRestoredHistory.list": { $slice: 6 },
            "log.blockMergedHistory.list": 1,
            "log.latestSizeCalculationDate": 1
          },
          (err, blocks) => {
            if (err) return reject(["Couldn't load folder history", err]);
            blocks.forEach(block => {
              if (block.log.provisionedDate) {
                items.push({
                  action: "Block provisioned in datbase",
                  timestamp: new Date(block.log.provisionedDate)
                });
              }
              processLogs(block.log.blockBinnedHistory.list, "Block binned");
              processLogs(
                block.log.blockRestoredHistory.list,
                "Block restored"
              );
              processLogs(block.log.blockMergedHistory.list, "Blocks merged");
              if (block.log.latestSizeCalculationDate) {
                items.push({
                  action: "Block size re-calculated",
                  timestamp: new Date(block.log.latestSizeCalculationDate)
                });
              }
            });
            if (doneFiles && (doneBlocks = true) && doneDownloads) onFound();
          }
        ).sort({ "log.latestSizeCalculationDate": -1 });
        Download.find(
          {
            owner: G.user._id,
            "log.requestedDate": { $gte: dateLowerBound },
            "log.completedDate": { $exists: true }
          },
          {
            "log.requestedDate": 1,
            "files.count": 1
          },
          (err, downloads) => {
            if (err) return reject(["Couldn't load folder history", err]);
            downloads.forEach(download => {
              items.push({
                action: `Downloaded ${download.files.count} file${
                  download.files.count > 1 ? "s" : ""
                }`,
                timestamp: new Date(download.log.requestedDate)
              });
            });
            if (doneFiles && doneBlocks && (doneDownloads = true)) onFound();
          }
        );
      });
    }
  });

  // ---------------------------------------

  stage.status = "loading";

  G.getUser((err, user) => {
    if (err || !user) {
      stage.status = "error";
      return G.notifyError("We couldn't get your user info", err);
    }
    G.user = user;
    if (!user.plan) {
      stage.status = "error";
      G.notifyError("Cannot show info without a plan");
      return $scope.$apply();
    }
    Promise.all([folders.load(), history.load()])
      .then(() => {
        $scope.$apply(() => {
          stage.status = "";
          stage.checkArgs();
        });
      })
      .catch(args => {
        $scope.$apply(() => {
          stage.status = "error";
          if (args) {
            console.log(args);
            G.notifyError(args[0], args[1]);
          }
        });
      });
    $scope.$apply();
  });

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    let startIndex = path.length - estLength;
    path = path.substr(startIndex < 0 ? 0 : startIndex, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "…" + path;
    }
    return path;
  }
});
