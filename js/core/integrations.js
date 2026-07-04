// ════════════════════════════════════════════
//  INTEGRATIONS
//  Google Drive + Gmail plumbing, extracted out of sendDocument.js so a
//  future module (e.g. Company Registration submissions) can search Drive
//  or send an emailed attachment without depending on that file. The
//  Send Document tab's own folder-structure knowledge and client-name
//  fuzzy-matching scoring (searchDrive()) stay in sendDocument.js — that's
//  business logic specific to this firm's Drive layout, not a generic
//  integration.
// ════════════════════════════════════════════
window.Integrations = (function () {
  // Every Drive API call MUST include these params or Shared Drive files
  // are invisible.
  async function driveGet(url) {
    const sep = url.includes('?') ? '&' : '?';
    const fullUrl = url + sep + 'supportsAllDrives=true&includeItemsFromAllDrives=true';
    const resp = await fetch(fullUrl, { headers: { Authorization: 'Bearer ' + window.accessToken } });
    return resp.json();
  }

  async function findFolderByName(parentId, nameVariants) {
    // Pass 1: exact name match
    for (const name of nameVariants) {
      let q = `mimeType='application/vnd.google-apps.folder' and name = '${name}' and trashed=false`;
      if (parentId) q += ` and '${parentId}' in parents`;
      const data = await driveGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`
      );
      if (data.files?.length > 0) return data.files[0].id;
    }
    // Pass 2: fuzzy contains match
    for (const name of nameVariants) {
      let q = `mimeType='application/vnd.google-apps.folder' and name contains '${name}' and trashed=false`;
      if (parentId) q += ` and '${parentId}' in parents`;
      const data = await driveGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`
      );
      if (data.files?.length > 0) return data.files[0].id;
    }
    return null;
  }

  async function listAllFilesInFolder(folderId) {
    const allFiles = [];
    const queue = [folderId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      let pageToken = null;

      do {
        const q = encodeURIComponent(`'${currentId}' in parents and trashed=false`);
        let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size,parents)&pageSize=1000`;
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

        const data = await driveGet(url);

        if (data.files) {
          for (const file of data.files) {
            if (file.mimeType === 'application/vnd.google-apps.folder') {
              queue.push(file.id);
            } else {
              allFiles.push(file);
            }
          }
        }

        pageToken = data.nextPageToken || null;
      } while (pageToken);
    }

    return allFiles;
  }

  async function downloadDriveFile(fileId) {
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: 'Bearer ' + window.accessToken } });
    if (!resp.ok) throw new Error('Could not download file from Drive.');
    return resp.blob();
  }

  // Sends `file` (a Drive file descriptor: {id, name, mimeType}) as an email
  // attachment. Subject/body are fully caller-supplied so this has no
  // knowledge of any particular module's document types or wording.
  async function sendEmailWithAttachment({ file, toEmail, subject, bodyText }) {
    const blob = await downloadDriveFile(file.id);
    const base64File = await blobToBase64(blob);
    const mimeType = file.mimeType || 'application/octet-stream';
    const boundary = 'Integrations_' + Date.now();

    const rawEmail = [
      `To: ${toEmail}`, `Subject: ${subject}`, `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`, ``,
      `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, ``, bodyText, ``,
      `--${boundary}`, `Content-Type: ${mimeType}; name="${file.name}"`,
      `Content-Disposition: attachment; filename="${file.name}"`,
      `Content-Transfer-Encoding: base64`, ``, base64File, `--${boundary}--`
    ].join('\r\n');

    const encodedEmail = btoa(unescape(encodeURIComponent(rawEmail))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + window.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodedEmail }),
    });
    if (!sendResp.ok) {
      const err = await sendResp.json();
      throw new Error(err.error?.message || 'Gmail send failed.');
    }
  }

  return { driveGet, findFolderByName, listAllFilesInFolder, downloadDriveFile, sendEmailWithAttachment };
})();
