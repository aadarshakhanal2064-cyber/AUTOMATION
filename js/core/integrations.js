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
  // Google Drive query strings are single-quoted; a name containing a quote or
  // backslash would otherwise break out of the literal (or let a future caller
  // that passes user-supplied names inject query terms). Per the Drive API
  // spec, escape backslash first, then the single quote. Today's callers pass
  // hardcoded folder names, but the engine escapes defensively so any future
  // consumer is safe by construction.
  function escDriveQuery(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

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
      let q = `mimeType='application/vnd.google-apps.folder' and name = '${escDriveQuery(name)}' and trashed=false`;
      if (parentId) q += ` and '${escDriveQuery(parentId)}' in parents`;
      const data = await driveGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`
      );
      if (data.files?.length > 0) return data.files[0].id;
    }
    // Pass 2: fuzzy contains match
    for (const name of nameVariants) {
      let q = `mimeType='application/vnd.google-apps.folder' and name contains '${escDriveQuery(name)}' and trashed=false`;
      if (parentId) q += ` and '${escDriveQuery(parentId)}' in parents`;
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

  // A single CR or LF in a header value lets an attacker inject extra headers
  // (e.g. a hidden Bcc) or a whole new MIME part — classic email header
  // injection. Strip every CR/LF from anything that lands on a header line.
  function stripHeader(s) {
    return String(s || '').replace(/[\r\n]+/g, ' ').trim();
  }

  // Header values may only contain ASCII; a Nepali/Unicode subject or filename
  // is otherwise a malformed header. RFC 2047 "encoded-word" wraps the UTF-8
  // bytes in base64 so the header stays pure-ASCII and mail clients decode it.
  function encodeHeaderWord(s) {
    const clean = stripHeader(s);
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7E]*$/.test(clean)) return clean; // already safe ASCII
    return '=?UTF-8?B?' + btoa(unescape(encodeURIComponent(clean))) + '?=';
  }

  // Builds the raw MIME message and sends it via Gmail — the one piece both
  // attachment sources (a Drive file, or a Blob generated in-browser) share.
  async function sendRawEmailWithBlob({ blob, filename, mimeType, toEmail, subject, bodyText }) {
    const base64File = await blobToBase64(blob);
    const boundary = 'Integrations_' + Date.now();

    const safeTo       = stripHeader(toEmail);
    const safeSubject  = encodeHeaderWord(subject);
    const safeFilename = encodeHeaderWord(filename);
    const safeMime     = stripHeader(mimeType);

    const rawEmail = [
      `To: ${safeTo}`, `Subject: ${safeSubject}`, `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`, ``,
      `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, ``, bodyText, ``,
      `--${boundary}`, `Content-Type: ${safeMime}; name="${safeFilename}"`,
      `Content-Disposition: attachment; filename="${safeFilename}"`,
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

  // Sends `file` (a Drive file descriptor: {id, name, mimeType}) as an email
  // attachment. Subject/body are fully caller-supplied so this has no
  // knowledge of any particular module's document types or wording.
  async function sendEmailWithAttachment({ file, toEmail, subject, bodyText }) {
    const blob = await downloadDriveFile(file.id);
    await sendRawEmailWithBlob({ blob, filename: file.name, mimeType: file.mimeType || 'application/octet-stream', toEmail, subject, bodyText });
  }

  // Sends a Blob generated in-browser (no Drive round-trip) — e.g. a Billing
  // invoice PDF built with PDF-Lib.
  async function sendEmailWithBlobAttachment({ blob, filename, mimeType, toEmail, subject, bodyText }) {
    await sendRawEmailWithBlob({ blob, filename, mimeType: mimeType || 'application/octet-stream', toEmail, subject, bodyText });
  }

  return { driveGet, findFolderByName, listAllFilesInFolder, downloadDriveFile, sendEmailWithAttachment, sendEmailWithBlobAttachment };
})();
