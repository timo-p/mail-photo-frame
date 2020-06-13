"use strict";

const imaps = require("imap-simple");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jo = require("jpeg-autorotate");
const piexif = require('piexifjs');
const AWS = require("aws-sdk");
const crypto = require("crypto");
const handlebars = require("handlebars");
const jimp = require("jimp");

const s3 = new AWS.S3();
const cloudfront = new AWS.CloudFront();

const getFiles = async marker => {
  const options = {
    Bucket: process.env.bucket,
    Prefix: "images/",
    Marker: marker
  };
  const res = await s3.listObjects(options).promise();
  let keys = res.Contents.map(c => c.Key);
  if (res.NextMarker) {
    const nextKeys = await getFiles(res.NextMarker);
    keys = keys.concat(nextKeys);
  }
  return keys.map(k => path.basename(k));
};

const invalidate = () => {
  const options = {
    DistributionId: process.env.distribution,
    InvalidationBatch: {
      CallerReference: new Date().getTime() + "",
      Paths: {
        Quantity: 2,
        Items: ["/index.html", "/images/*"]
      }
    }
  };
  return cloudfront.createInvalidation(options).promise();
};

const getHash = input =>
  crypto
  .createHmac("sha256", "asd")
  .update(input)
  .digest("hex");

const shouldInvalidate = async indexHtml => {
  const oldIndex = await s3
    .getObject({
      Bucket: process.env.bucket,
      Key: "index.html"
    })
    .promise();
  const oldIndexHash = getHash(oldIndex.Body);
  const newIndexHash = getHash(Buffer.from(indexHtml, "utf8"));
  return oldIndexHash !== newIndexHash;
};

const buildResponse = event => ({
  statusCode: 200,
  body: JSON.stringify({
      message: "Go Serverless v1.0! Your function executed successfully!",
      input: event
    },
    null,
    2
  )
});

const getAttachments = async (imaps, connection, messages) => {
  let attachmentPromises = [];

  messages.forEach(message => {
    const parts = imaps.getParts(message.attributes.struct);
    attachmentPromises = attachmentPromises.concat(
      parts
      .filter(part => {
        return (
          part.type === "image" &&
          part.disposition && ["INLINE", "ATTACHMENT"].includes(
            part.disposition.type.toUpperCase()
          )
        );
      })
      .map(function (part) {
        // retrieve the attachments only of the messages with attachments
        return connection.getPartData(message, part).then(function (partData) {
          return {
            filename: part.disposition.params.filename,
            data: partData
          };
        });
      })
    );
  });
  console.log(`Fetching ${attachmentPromises.length} attachments...`);
  return await Promise.all(attachmentPromises);
};

const deleteThumbnailFromExif = (imageBuffer) => {
  const imageString = imageBuffer.toString('binary');
  const exifObj = piexif.load(imageString);
  delete exifObj.thumbnail;
  delete exifObj['1st'];
  const exifBytes = piexif.dump(exifObj);
  const newImageString = piexif.insert(exifBytes, imageString);
  return Buffer.from(newImageString, 'binary');
}

const rotateImage = async (buffer, filename, isRetry) => {
  try {
    const res = await jo.rotate(buffer, {
      quality: 100
    });
    return res.buffer;
  } catch (error) {
    if (
      [jo.errors.correct_orientation, jo.errors.no_orientation].includes(
        error.code
      )
    ) {
      console.log(`The orientation of ${filename} is already correct!`);
    } else if (!isRetry) {
      console.log('Removing thumbnail from image and retrying');
      return rotateImage(deleteThumbnailFromExif(buffer), filename, true);
    } else {
      throw error;
    }
  }
  return buffer;
};

const resizeImage = async buffer => {
  const tmpFile = path.join(os.tmpdir(), getHash(buffer));
  console.log(tmpFile);
  fs.writeFileSync(tmpFile, buffer);
  const image = await jimp.read(tmpFile);
  return image.scaleToFit(1280, 800).getBufferAsync(jimp.AUTO);
};

const updateAttachments = async attachments => {
  console.log(`Loading files from s3://${process.env.bucket}/`);
  const existingFiles = await getFiles();

  for (let attachment of attachments) {
    let buffer = attachment.data;
    buffer = await rotateImage(buffer, attachment.filename);
    buffer = await resizeImage(buffer);
    const hash = crypto
      .createHmac("sha256", "asd")
      .update(buffer)
      .digest("hex");

    const filename = `${hash}${path.extname(attachment.filename)}`;
    if (existingFiles.includes(filename)) {
      console.log(
        `File ${attachment.filename} with hash ${hash} already exists`
      );
    } else {
      console.log(
        `Uploading ${attachment.filename} to s3://${process.env.bucket}/${filename}`
      );
      await s3
        .putObject({
          Body: buffer,
          Bucket: process.env.bucket,
          Key: `images/${filename}`
        })
        .promise();
    }
  }
};

const updater = async event => {
  const config = {
    imap: {
      user: process.env.username,
      password: process.env.password,
      host: process.env.address,
      port: 993,
      tls: true,
      authTimeout: 5000,
      tlsOptions: {
        rejectUnauthorized: false
      }
    }
  };

  console.log("Connecting...");
  const connection = await imaps.connect(config);
  console.log("Connected. Opening box UNREAD_PHOTOS...");
  await connection.openBox("UNREAD_PHOTOS");
  console.log("Box open");
  var searchCriteria = ["UNSEEN"];

  var fetchOptions = {
    bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)"],
    struct: true,
    markSeen: false
  };

  console.log("Fetching messages...");
  const messages = await connection.search(searchCriteria, fetchOptions);
  console.log(`${messages.length} messages fetched`);

  const attachments = await getAttachments(imaps, connection, messages);
  console.log("Attachments fetched");

  if (attachments.length > 0) {
    await updateAttachments(attachments);
  }

  console.log("Moving messages to READ_PHOTOS");
  for (let message of messages) {
    await connection.moveMessage(message.attributes.uid, "READ_PHOTOS");
  }

  console.log("Building template");
  const files = await getFiles();
  const template = fs
    .readFileSync("./templates/index.html", {
      encoding: "utf-8"
    })
    .toString();
  const builtTemplate = handlebars.compile(template);
  const compiled = builtTemplate({
    files,
    ga: process.env.ga,
  });

  if (await shouldInvalidate(compiled)) {
    console.log("Uploading index.html");

    await s3
      .putObject({
        Body: Buffer.from(compiled, "utf8"),
        Bucket: process.env.bucket,
        ContentType: "text/html",
        Key: "index.html"
      })
      .promise();

    console.log("Invalidating CloudFront");
    await invalidate();
  } else {
    console.log("index.html has not changed. Not updating.");
  }

  return buildResponse(event);
};

module.exports.updater = updater;