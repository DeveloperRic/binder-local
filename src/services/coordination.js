/*
  -----------------------------------------------------------

  This file is used to coordinate constants and functions
  implemented in both the upload and download services.

  NOTE:
  It is CRUITIAL NOT TO UPDATE ANYTHING HERE UNLESS
  ABSOLUTELY NECESSARY. This is because critical processes
  such as encryption and decryption rely on the consistency
  of information such as part lengths in large files

  -----------------------------------------------------------
*/

/**
 * Given a fileDat obj, returns true if the file is considered large,
 * returns false otherwise.
 * @param {"FileData"} fileDat
 */
function isLargeFile(fileDat) {
  // 1   gb  = 1073741824
  // 150 mb  = 157286400
  // 50  mb  = 52428800
  return (fileDat.size || fileDat.bytes.total) >= 157286400;
}

/**
 * Returns the minimum number of 50Mb parts whose total
 * size would be in the range
 *  [ fileSize, fileSize + 50mb )
 * @param {"FileData"} fileDat
 */
function countPartsForLargeFile(fileDat) {
  // divide into 50mb parts
  let partsCount = Math.ceil((fileDat.size || fileDat.bytes.total) / 52428800);
  // ensure parts is within allowed b2 parts-count range
  return partsCount <= 10000 ? partsCount : 10000;
}

module.exports = {
  isLargeFile,
  countPartsForLargeFile
};
