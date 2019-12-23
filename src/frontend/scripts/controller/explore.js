// explore ctrl
app.controller("exploreCtrl", function($scope, $rootScope, $interval) {
  const pathParse = require("path-parse");
  const pathToRegex = require("path-to-regexp");
  const ip = require("ip");
  const G = $rootScope.G;
  const { findCommonPrefix, normalisePath } = G.require(
    "services/coordination"
  );
  const File = G.clientModels.File;

  //TODO specific history for each file
  // TODO allow users to force upload now
  // TODO notify user of files held in database that no longer exist in fs

  // ---------------------------------------

  var stage = ($scope.stage = {
    status: "waiting",
    applyFilterFromRedirect: () => {
      return new Promise((resolve, reject) => {
        if (G.stageStack.switchArgs.explore) {
          let parentPath = G.stageStack.switchArgs.explore[0];
          if (parentPath) {
            return source
              .load(parentPath)
              .then(() => resolve(true))
              .catch(reject);
          }
        }
        resolve(false);
      });
    }
  });

  var source = ($scope.source = {
    status: "waiting",
    stack: [],
    current: null,
    selected: [],
    load: parentPath => {
      return new Promise((resolve, reject) => {
        source.status = "loading";
        findRoot()
          .then(root => {
            if (!root) return resolve();
            let regex = pathToRegex(`${root}(\\\\|/)${parentPath || "(.*)"}`);
            //   delimiter: "$",
            //   strict: true
            // });
            console.log({ $regex: regex.source, $options: regex.flags });
            File.aggregate(
              [
                {
                  $match: {
                    owner: G.toObjectId(G.user._id),
                    plan: G.toObjectId(G.user.plan._id),
                    localPath: { $regex: regex.source, $options: regex.flags },
                    deleted: false
                  }
                },
                {
                  $project: {
                    _id: 1,
                    localPath: "$localPath",
                    binned: "$binned",
                    pendingDeletion: "$pendingDeletion",
                    latestSize: "$latestSize",
                    versionsCount: "$versions.activeCount"
                  }
                }
              ],
              (err, files) => {
                if (err) {
                  source.status = "error";
                  return reject(err);
                }
                let commonPrefix = findCommonPrefix(files);
                console.log(commonPrefix);
                let folders = splitFoldersFromFiles(files, commonPrefix);
                files = folders[0].map(f => {
                  return addFileContextMenu(
                    Object.assign(f, {
                      parent: parentPath,
                      sized: formatSize(f.latestSize)
                    })
                  );
                });
                folders = folders[1].map(f => {
                  f.localPath = commonPrefix + f.fullName;
                  let explorePath = f.localPath.replace(root, "") + "/(.*)";
                  if (explorePath.startsWith("/")) {
                    explorePath = explorePath.substr(1);
                  }
                  explorePath = explorePath.replace(/\//g, "(\\\\|/)");
                  return Object.assign(f, {
                    parent: parentPath,
                    explorePath,
                    sized: formatSize(f.latestSize),
                    fileCounted: `${f.fileCount} files`,
                    contextMenu: [
                      {
                        html: contextMenuHTML(
                          "file_download",
                          "Download folder"
                        ),
                        click: () => actions.downloadFolder(f)
                      },
                      {
                        html: contextMenuHTML("delete", "Delete folder"),
                        click: () => actions.deleteFolder(f)
                      }
                    ]
                  });
                });
                folders.sort((a, b) =>
                  a.name < b.name ? -1 : a.name > b.name ? 1 : 0
                );
                files.sort((a, b) =>
                  a.name < b.name ? -1 : a.name > b.name ? 1 : 0
                );
                source.current = {
                  name: smallerPath(commonPrefix, 30),
                  folders: folders,
                  files: files
                };
                console.log(source.current);
                resolve();
              }
            );
          })
          .catch(err => {
            source.status = "error";
            reject(err);
          });

        function formatSize(size) {
          if (size >= 1073741824) {
            return `${(size / 1073741824).toFixed(1)} Gb`;
          } else if (size >= 1048576) {
            return `${(size / 1048576).toFixed(1)} Mb`;
          } else if (size >= 1024) {
            return `${(size / 1024).toFixed(1)} Kb`;
          } else {
            return "< 1 Kb";
          }
        }

        function splitFoldersFromFiles(list, { length }) {
          let files = [];
          let folders = [];
          let item;
          while ((item = list[0])) {
            let slashIndex = item.localPath.indexOf("/", length + 1);
            if (slashIndex >= 0) {
              item.fullName = item.localPath.substr(
                length,
                slashIndex - length
              );
              item.name = smallerPath(item.fullName, 30);
              folders.push(list.shift());
            } else {
              item.name = smallerPath(item.localPath.substr(length), 40);
              files.push(list.shift());
            }
          }
          let groups = [];
          while ((item = folders[0])) {
            item._id = item._id.toString();
            let folder = groups.find(f => f.name == item.name);
            if (folder) {
              folder.latestSize += item.latestSize;
              folder.fileCount++;
              folder.fileIds.push(item._id);
            } else {
              groups.push({
                fullName: item.fullName,
                name: item.name,
                latestSize: item.latestSize,
                fileCount: 1,
                fileIds: [item._id]
              });
            }
            folders.shift();
          }
          return [files, groups];
        }
      }).then(() => {
        source.status = "";
        source.stack.push(parentPath);
      });
    },
    enter: parentPath => {
      source
        .load(parentPath)
        .then(() => $scope.$apply())
        .catch(err => catchErr(err, source));
    },
    back: () => {
      if (source.stack.length < 2) return;
      source.load(source.stack[source.stack.length - 2]).then(() => {
        source.stack.length -= 2;
        $scope.$apply();
      });
    },
    select: file => {
      let index = source.selected.indexOf(file.localPath);
      //TODO handle context menu on multi-select
      if (index < 0) {
        source.selected.length = 0;
        source.selected.push(file.localPath);
        console.log(file.contextMenu);
      } else {
        source.selected.splice(index, 1);
      }
    }
  });

  var actions = {
    downloadFile: file => {
      G.switchStage("download", file._id);
    },
    deleteFile: file => {
      G.notifyInfo(
        "Are you sure you want to delete this file?",
        false,
        confirmed => {
          if (confirmed) {
            G.notifyLoading(true);
            File.updateOne(
              { _id: file._id },
              { pendingDeletion: true },
              err => {
                G.notifyLoading(false);
                if (err) G.notifyError("Failed to delete the file", err);
                G.notifyInfo(
                  "The file has been queued for deletion within 24 hours"
                );
                $scope.$apply();
              }
            );
          }
        },
        true
      );
    },
    downloadFolder: folder => {
      G.switchStage("download", folder.fileIds);
    },
    deleteFolder: folder => {
      let len = folder.fileIds.length;
      if (len == 0) {
        return G.notifyError("This folder is empty");
      }
      G.notifyInfo(
        `Are you sure you want to delete ${len} file(s)`,
        false,
        confirmed => {
          if (confirmed) {
            G.notifyLoading(true);
            new Promise((resolve, reject) => {
              File.updateMany(
                { _id: { $in: folder.fileIds } },
                { pendingDeletion: true },
                err => {
                  if (err) return reject(err);
                  resolve();
                }
              );
            })
              .then(() => {
                G.notifyInfo(
                  `${len} file${
                    len == 1 ? " has" : "s have"
                  } been queued for deletion within 24 hours`
                );
              })
              .catch(err => {
                G.notifyError("Failed to delete the files", err);
              })
              .finally(() => {
                G.notifyLoading(false);
                $scope.$apply();
              });
          }
        },
        true
      );
    },
    restore: file => {
      G.notifyLoading(true);
      new Promise((resolve, reject) => {
        File.aggregate(
          [
            { $match: { _id: G.toObjectId(file._id) } },
            {
              $project: {
                _id: 1,
                idInDatabase: "$idInDatabase",
                version: "$versions.list"
              }
            },
            { $unwind: "$version" },
            { $match: { "version.dateDeleted": { $exists: false } } },
            {
              $project: {
                _id: 1,
                idInDatabase: "$idInDatabase",
                "version._id": "$version._id",
                "version.idInDatabase": "$version.idInDatabase",
                "version.dateInserted": "$version.dateInserted",
                "version.originalSize": "$version.originalSize"
              }
            },
            { $sort: { "version.dateInserted": -1 } }
          ],
          (err, versions) => {
            G.notifyLoading(false);
            if (err) return reject([err]);
            if (versions.length == 0) {
              return reject([
                null,
                [
                  "No rollback versions are available. ",
                  "Perhaps they've all expired?"
                ]
              ]);
            }
            let currentId;
            for (let i = 0; i < versions.length; i++) {
              let version = versions[i];
              if (
                version.idInDatabase == version.version.idInDatabase.toString()
              ) {
                currentId = version.idInDatabase;
                versions.splice(i, 1);
                i--;
                continue;
              }
              version = versions[i] = version.version;
              version.idInDatabase = version.idInDatabase.toString();
            }
            if (!currentId) {
              return reject([new Error("No current version found")]);
            }
            G.notifyChoose(
              "custom",
              {
                name: "Pick a rollback version",
                children: versions.map(version => {
                  let size = version.originalSize;
                  if (size >= 1073741824) {
                    size = `${(size / 1073741824).toFixed(1)} Gb`;
                  } else if (size >= 1048576) {
                    size = `${(size / 1048576).toFixed(1)} Mb`;
                  } else if (size >= 1024) {
                    size = `${(size / 1024).toFixed(1)} Kb`;
                  } else {
                    size = "< 1 Kb";
                  }
                  let dateName = new Date(version.dateInserted).toString();
                  dateName = dateName.substr(0, dateName.indexOf("GMT"));
                  return {
                    id: version._id.toString(),
                    name: `${dateName}  [ ${size} ]`
                  };
                })
              },
              versionId => {
                if (!versionId) return resolve(false);
                versionId = versionId.id;
                let selected = versions.find(v => v._id == versionId);
                if (!selected || selected.idInDatabase == currentId) {
                  return resolve(false);
                }
                G.notifyLoading(true);
                File.updateOne(
                  { _id: file._id },
                  {
                    idInDatabase: selected.idInDatabase,
                    $push: {
                      "log.rollbackHistory.list": {
                        $each: [
                          {
                            date: Date.now(),
                            ipAddress:
                              ip.address("public", "ipv6") ||
                              ip.address("public", "ipv4"),
                            reason: "User requested a rollback"
                          }
                        ],
                        $sort: { date: -1 }
                      }
                    },
                    $inc: {
                      "log.rollbackHistory.count": 1
                    }
                  },
                  err => {
                    if (err) return reject([err]);
                    resolve(true);
                  }
                );
              }
            );
            $scope.$apply();
          }
        );
      })
        .finally(() => G.notifyLoading(false))
        .then(done => {
          if (done) {
            G.notifyInfo("Your file has been rolled back");
          }
        })
        .catch(err => {
          G.notifyError(err[1] || "Something went wrong", err[0]);
        })
        .then(() => $scope.$apply());
    },
    toggleIncludeFile: (file, include) => {
      G.notifyLoading(true);
      setImmediate(async () => {
        try {
          let fileIsIgnored = !G.ipcRenderer.sendSync(
            "spider-check-file",
            file.localPath
          );
          if (fileIsIgnored == include) {
            let allowResponses = true;
            let timeoutTask = $interval(
              () => {
                allowResponses = false;
                G.notifyError("DirStore took too long to respond");
                G.notifyLoading(false);
              },
              10000,
              1
            );
            G.ipcRenderer
              .removeAllListeners("spider-select-file-err")
              .removeAllListeners("spider-select-file-res")
              .once("spider-select-file-err", (e, err) => {
                if (!allowResponses) return;
                allowResponses = false;
                $interval.cancel(timeoutTask);
                G.notifyError(
                  `Failed to ${include ? "include" : "ignore"} file`,
                  err
                );
                G.notifyLoading(false);
                $scope.$apply();
              })
              .once("spider-select-file-res", () => {
                if (!allowResponses) return;
                allowResponses = false;
                $interval.cancel(timeoutTask);
                let index = source.current.files.findIndex(
                  f => f.localPath == file.localPath
                );
                if (index >= 0) {
                  source.current.files[index] = addFileContextMenu(file);
                } else {
                  G.notifyError(
                    "Failed the refresh the list. Please do it manually"
                  );
                }
                G.notifyLoading(false);
                $scope.$apply();
              })
              .send("spider-select-file", {
                path: file.localPath,
                include
              });
            return;
          }
        } catch (err) {
          G.notifyError(
            `Failed to ${include ? "include" : "ignore"} file`,
            err
          );
        }
        G.notifyLoading(false);
        $scope.$apply();
      });
    }
  };

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
    stage.status = "";
    $scope.$$postDigest(() => {
      stage
        .applyFilterFromRedirect()
        .then(applied => {
          if (!applied) {
            return source.load("").catch(err => catchErr(err, stage));
          }
        })
        .then(() => $scope.$apply())
        .catch(err => catchErr(err, stage));
    });
    $scope.$apply();
  }, "plan._id");

  function addFileContextMenu(f) {
    let fileIsIgnored = !G.ipcRenderer.sendSync(
      "spider-check-file",
      f.localPath
    );
    console.log(fileIsIgnored);
    f.contextMenu = [
      {
        html: contextMenuHTML("file_download", "Download file"),
        displayed: !f.pendingDeletion,
        click: () => actions.downloadFile(f)
      },
      {
        html: contextMenuHTML("delete", "Delete file"),
        displayed: !f.pendingDeletion,
        click: () => actions.deleteFile(f)
      },
      {
        html: contextMenuHTML("settings_backup_restore", "Roll-back"),
        displayed: !f.pendingDeletion && f.versionsCount > 1,
        click: () => actions.restore(f)
      },
      {
        html: contextMenuHTML("visibility_off", "Ignore file"),
        displayed: !f.pendingDeletion && !fileIsIgnored,
        click: () => actions.toggleIncludeFile(f, false)
      },
      {
        html: contextMenuHTML("visibility", "Un-ignore file"),
        displayed: !f.pendingDeletion && fileIsIgnored,
        click: () => actions.toggleIncludeFile(f, true)
      },
      {
        html: contextMenuHTML("live_help", "What's this?"),
        displayed: f.pendingDeletion,
        click: () =>
          G.notifyInfo([
            "This file has been marked as 'pending deletion'.",
            "Which means that within the next 24 hours, the file and all data associated with it will be removed from Binder.",
            "This operation is unfortunately irreversible.",
            "For more help, check the Help page."
          ])
      }
    ];
    return f;
  }

  function contextMenuHTML(icon, text) {
    return (
      "<span class='context-menu-item'><i class='material-icons'>" +
      icon +
      "</i>" +
      text +
      "</span>"
    );
  }

  function catchErr(err, statusHolder) {
    if (err && err[0]) {
      G.notifyError(err[0], err[1]);
    } else {
      G.notifyError("Couldn't load files", err);
    }
    statusHolder.status = "error";
  }

  function findRoot() {
    return new Promise((resolve, reject) => {
      File.find({ owner: G.user._id }, { localPath: 1 }, (err, [root]) => {
        if (err) return reject(err);
        if (!root) return resolve();
        root = pathParse(normalisePath(root.localPath)).root;
        if (!root) {
          return reject(new Error("Couldn't find the file root"));
        }
        if (root.endsWith("/")) {
          root = root.substr(0, root.length - 1);
        }
        resolve(root);
      }).limit(1);
    });
  }

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
