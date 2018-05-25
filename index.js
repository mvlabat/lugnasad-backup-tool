const nodemailer = require('nodemailer');
const B2 = require('backblaze-b2');
const fs = require('fs');
const path = require('path');
const randomWords = require('random-words');
const { execSync } = require('child_process');
const crypto = require('crypto');
require('dotenv').config();

const followRedirects = require('follow-redirects');

followRedirects.maxBodyLength = 1024 * 1024 * 1024;

const DAY = 1000 * 60 * 60 * 24;
const WEEK = DAY * 7;
const MONTH = DAY * 30;

const DAY_FILENAME = 'day.7z';
const WEEK_FILENAME = 'week.7z';
const MONTH_FILENAME = 'month.7z';

const b2 = new B2({
  accountId: process.env.B2_ACCOUNT_ID,
  applicationKey: process.env.B2_APP_KEY,
});

/**
 * @return {string} filename
 */
function getFirstFileToUpdate(files) {
  let hasDailyFile = false;
  let hasWeeklyFile = false;
  let hasMonthlyFile = false;
  const currentTime = new Date().getTime();

  const outdatedFile = files.find((file) => {
    if (file.fileName === DAY_FILENAME) {
      hasDailyFile = true;
      if (currentTime - file.uploadTimestamp > DAY) {
        return true;
      }
    } else if (file.fileName === WEEK_FILENAME) {
      hasWeeklyFile = true;
      if (currentTime - file.uploadTimestamp > WEEK) {
        return true;
      }
    } else if (file.fileName === MONTH_FILENAME) {
      hasMonthlyFile = true;
      if (currentTime - file.uploadTimestamp > MONTH) {
        return true;
      }
    }
    return false;
  });

  if (outdatedFile) {
    return outdatedFile;
  }

  if (!hasDailyFile) {
    return DAY_FILENAME;
  }
  if (!hasWeeklyFile) {
    return WEEK_FILENAME;
  }
  if (!hasMonthlyFile) {
    return MONTH_FILENAME;
  }

  return null;
}

function getBackupPath(fileName) {
  return path.join(process.env.BACKUP_DIR, fileName);
}

function createBackup() {
  let lugnasadBucketId = null;
  return b2.authorize()
    .then(() => {
      console.log('Loading the buckets list...');
      return b2.listBuckets();
    })
    .then((response) => {
      const bucket = response.data.buckets.find(b => b.bucketName === 'lugnasad');
      if (bucket) {
        console.log(bucket);
        lugnasadBucketId = bucket.bucketId;
        console.log('Loading the files list...');
        return b2.listFileVersions({
          bucketId: lugnasadBucketId,
        });
      }
      throw new Error('"lugnasad" bucket is not found');
    })
    .then((response) => {
      console.log(response.data);
      const { files } = response.data;
      const updatedFile = getFirstFileToUpdate(files);
      if (updatedFile) {
        console.log(`Going to make '${updatedFile}' backup...`);
        const passphrase = randomWords(5).join('_');
        console.log('Making sql-dump...');
        execSync('drush sql-dump > dump.sql', { cwd: process.env.DRUPAL_DIR });
        console.log('Packing with 7z...');
        execSync(`7z a -t7z -m0=lzma2 -mx=9 -mfb=64 -md=32m -ms=on -mmt=off -mhe=on -p'${passphrase}' ${getBackupPath(updatedFile)} ${process.env.DRUPAL_DIR}`);
        return [passphrase, lugnasadBucketId, updatedFile];
      }
      return [null, null, null];
    });
}

async function sendBackup(passphrase, lugnasadBucketId, fileName) {
  if (!fileName) {
    return [null, null];
  }

  return b2.authorize()
    .then(() => {
      console.log('Loading the list of old file versions...');
      return b2.listFileVersions({
        bucketId: lugnasadBucketId,
        startFileName: fileName,
      });
    })
    .then((response) => {
      console.log(response.data);
      const { files } = response.data;

      if (files.length > 0) {
        console.log('Old file version was found. Deleting...');
        const promises = files.map(file => b2.deleteFileVersion({
          fileId: file.fileId,
          fileName: file.fileName,
        }));
        return Promise.all(promises);
      }
      return true;
    })
    .then((response) => {
      if (response !== true) {
        console.log('The old file has been deleted successfully.');
      }
      console.log('Getting upload url...');
      return b2.getUploadUrl(lugnasadBucketId);
    })
    .then((response) => {
      console.log('Loading the backup file...');
      const data = fs.readFileSync(getBackupPath(fileName));
      const sha1 = crypto.createHash('sha1');
      sha1.update(data);
      console.log('Starting uploading the file...');
      return b2.uploadFile({
        uploadUrl: response.data.uploadUrl,
        uploadAuthToken: response.data.authorizationToken,
        filename: fileName,
        data: fs.readFileSync(getBackupPath(fileName)),
        hash: sha1.digest('hex'),
      });
    })
    .then((response) => {
      const fileResponse = response.data;
      console.log(fileResponse);
      console.log('Success!');
      return [passphrase, fileResponse];
    });
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

function sendMail(passphrase, response, success) {
  const status = success ? 'success' : 'failed';
  const text = success
    ? `Passphrase: ${passphrase}\n\n${JSON.stringify(response, null, 4)}`
    : response.toString();
  const mailOptions = {
    from: process.env.MAIL_FROM,
    to: process.env.MAIL_TO,
    subject: `Backup status: ${status}`,
    text,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
    } else {
      console.log(`Email sent: ${info.response}`);
    }
  });
}

function cleanup() {
  console.log('Cleaning up...');
  fs.readdir(process.env.BACKUP_DIR, (readError, files) => {
    if (readError) throw readError;

    for (const file of files) {
      fs.unlink(path.join(process.env.BACKUP_DIR, file), (unlinkError) => {
        if (unlinkError) throw unlinkError;
      });
    }
  });
}

function run() {
  createBackup()
    .then(([passphrase, lugnasadBucketId, fileName]) =>
      sendBackup(passphrase, lugnasadBucketId, fileName))
    .then(([passphrase, response]) => {
      if (response) {
        sendMail(passphrase, response, true);
      } else {
        console.log('There is no need to backup yet');
      }
      cleanup();
    })
    .catch((err) => {
      console.error(err);
      cleanup();
      sendMail(null, err, false);
    });
}

setInterval(run, process.env.PERIOD);
run();
