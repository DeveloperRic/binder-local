// explore ctrl
app.controller("exploreCtrl", function($scope, $rootScope, $interval) {
  const pathParse = require("path-parse");
  const pathToRegex = require("path-to-regexp");
  const G = $rootScope.G;
  var File = G.clientModels.File;

  //TODO specific history for each file

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
                    owner: G.user._id,
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
                // {
                //   $group: {
                //     _id: {
                //       dir: {
                //         $substrCP: [
                //           "$localPath",
                //           parentLength,
                //           {
                //             $subtract: [
                //               { $strLenCP: "$localPath" },
                //               parentLength
                //             ]
                //           }
                //         ]
                //       }
                //     },
                //     files: {
                //       $push: {
                //         _id: "$_id",
                //         localPath: "$localPath",
                //         binned: "$binned",
                //         pendingDeletion: "$pendingDeletion",
                //         latestSize: "$latestSize"
                //       }
                //     }
                //   }
                // }
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
                  return Object.assign(f, {
                    parent: parentPath,
                    sized: formatSize(f.latestSize),
                    contextMenu: [
                      {
                        html: contextMenuHTML("file_download", "Download file"),
                        click: () => actions.downloadFile(f)
                      },
                      {
                        html: contextMenuHTML("delete", "Delete file"),
                        displayed: !f.pendingDeletion,
                        click: () => actions.deleteFile(f)
                      },
                      {
                        html: contextMenuHTML(
                          "settings_backup_restore",
                          "Roll-back"
                        ),
                        displayed: f.versionsCount > 1,
                        click: () => actions.restore(f)
                      }
                    ]
                  });
                });
                folders = folders[1].map(f => {
                  let explorePath =
                    commonPrefix.replace(root, "") + f.name + "/(.*)";
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

        function contextMenuHTML(icon, text) {
          return (
            "<span class='context-menu-item'><i class='material-icons'>" +
            icon +
            "</i>" +
            text +
            "</span>"
          );
        }

        function formatSize(size) {
          console.log(size);
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
              item.name = smallerPath(
                item.localPath.substr(length, slashIndex - length),
                40
              );
              folders.push(list.shift());
            } else {
              item.name = smallerPath(item.localPath.substr(length), 45);
              files.push(list.shift());
            }
          }
          let groups = [];
          while ((item = folders[0])) {
            let folder = groups.find(f => f.name == item.name);
            if (folder) {
              folder.latestSize += item.latestSize;
              folder.fileCount++;
            } else {
              groups.push({
                name: item.name,
                latestSize: item.latestSize,
                fileCount: 1
              });
            }
            folders.shift();
          }
          return [files, groups];
        }

        function findCommonPrefix(files) {
          if (files.length == 0) return "";
          for (let i in files) {
            files[i].localPath = normalisePath(files[i].localPath);
          }
          let oldNextPrefix;
          let nextPrefix = files[0].localPath.substr(
            0,
            files[0].localPath.indexOf("/") + 1
          );
          let commonPrefix = "";
          while (nextPrefix) {
            if (
              files.findIndex(f => !f.localPath.startsWith(nextPrefix)) >= 0
            ) {
              break;
            }
            commonPrefix = nextPrefix;
            nextPrefix += files[0].localPath.substr(
              nextPrefix.length,
              files[0].localPath.indexOf("/", nextPrefix.length + 1) -
                nextPrefix.length
            );
            if (nextPrefix == oldNextPrefix) break;
            oldNextPrefix = nextPrefix;
          }
          return commonPrefix;
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
      let index = source.selected.indexOf(file.localPath)
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
      G.notifyError("Action not implemented yet");
    },
    deleteFile: file => {
      G.notifyError("Action not implemented yet");
    },
    downloadFolder: folder => {
      G.notifyError("Action not implemented yet");
    },
    deleteFolder: folder => {
      G.notifyError("Action not implemented yet");
    },
    restore: file => {
      G.notifyError("Action not implemented yet");
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
  });

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

  function normalisePath(path) {
    return path.replace(new RegExp(G.regexEscape("\\"), "g"), "/");
  }

  function smallerPath(path, estLength) {
    let orgLength = path.length;
    path = path.substr(path.length - estLength, estLength);
    if (path.includes("/")) {
      path = path.substr(path.indexOf("/"));
    } else if (orgLength > estLength) {
      path = "..." + path;
    }
    return path;
  }
});
