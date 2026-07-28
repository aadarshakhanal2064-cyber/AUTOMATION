// ════════════════════════════════════════════
//  FIND + SEND DOCUMENT
// ════════════════════════════════════════════

// The found file belongs to the client that was in the box when Find ran.
// Any change to the client, document type or fiscal year invalidates it, so
// Send can never mail one client's document to another's address.
function sdClearFoundFile() {
  if (!window.foundFile) return;   // nothing staged — leave any other status alone
  window.foundFile = null;
  const preview = document.getElementById('file-preview');
  const sendBtn = document.getElementById('sendBtn');
  if (preview) preview.style.display = 'none';
  if (sendBtn) sendBtn.style.display = 'none';
  showStatus('ℹ️ The document you found was for the previous selection — search again before sending.', 'info');
}

['clientName', 'clientEmail', 'docType', 'fiscalYear'].forEach(id => {
  const el = document.getElementById(id);
  if (el) { el.addEventListener('input', sdClearFoundFile); el.addEventListener('change', sdClearFoundFile); }
});

async function findDocument() {
  const clientName  = document.getElementById('clientName').value.trim();
  const docType     = document.getElementById('docType').value;
  const fiscalYear  = document.getElementById('fiscalYear').value.trim();
  const clientEmail = document.getElementById('clientEmail').value.trim();

  if (!clientName || !docType) { showStatus('⚠️ Please fill in Client Name and Document Type.', 'info'); return; }
  if (!clientEmail) { showStatus('⚠️ Please fill in the Client Email before searching.', 'info'); return; }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching…';
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('file-preview').style.display = 'none';
  window.foundFile = null;

  try {
    showStatus('<span class="spinner spinner-navy"></span> Searching inside your Drive folders…', 'searching');
    const file = await searchDrive(clientName, docType, fiscalYear);

    if (!file) {
      showStatus(`❌ No file found for "<strong>${escHtml(clientName)}</strong>" (<strong>${escHtml(docType)}</strong>). Check the file name contains the client name inside the correct folder.`, 'error');
      btn.disabled = false; btn.innerHTML = '🔍 Find Document';
      return;
    }

    window.foundFile = file;
    document.getElementById('preview-name').textContent = file.name;
    document.getElementById('preview-meta').textContent = '✅ Found in Google Drive · Click "Send to Client" to send';
    document.getElementById('file-preview').style.display = 'flex';

    if (file._warning) {
      // _warning embeds clientName; escape since it flows into innerHTML
      showStatus('⚠️ ' + escHtml(file._warning) + ' — Please verify before sending.', 'info');
    } else {
      // file.name comes from Google Drive — treat as untrusted in HTML context
      showStatus(`✅ File found: <strong>${escHtml(file.name)}</strong> — Confirm this is correct then click <strong>Send to Client</strong>.`, 'success');
    }
    document.getElementById('sendBtn').style.display = 'inline-flex';

  } catch (err) { showStatus('❌ ' + err.message, 'error'); }

  btn.disabled = false; btn.innerHTML = '🔍 Find Document';
}

async function sendFoundDocument() {
  if (!window.foundFile) { showStatus('⚠️ Please find a document first.', 'info'); return; }

  const clientName  = document.getElementById('clientName').value.trim();
  const docType     = document.getElementById('docType').value;
  const fiscalYear  = document.getElementById('fiscalYear').value.trim();
  const clientEmail = document.getElementById('clientEmail').value.trim();

  const sendBtn   = document.getElementById('sendBtn');
  const searchBtn = document.getElementById('searchBtn');
  sendBtn.disabled = true; searchBtn.disabled = true;
  sendBtn.innerHTML = '<span class="spinner"></span> Sending…';
  showStatus(`<span class="spinner spinner-navy"></span> Sending <strong>${escHtml(window.foundFile.name)}</strong> to <strong>${escHtml(clientEmail)}</strong>…`, 'searching');

  const logEntry = {
    sent_by:       window.currentUser.email,
    client_name:   clientName,
    client_email:  clientEmail,
    doc_type:      docType,
    fiscal_year:   fiscalYear,
    file_name:     window.foundFile.name,
    drive_file_id: window.foundFile.id,
    status:        'pending',
    error_msg:     null,
  };

  try {
    await sendEmail(window.foundFile, clientName, docType, fiscalYear, clientEmail);
    logEntry.status = 'sent';
    showStatus(`✅ Successfully sent <strong>${escHtml(window.foundFile.name)}</strong> to <strong>${escHtml(clientEmail)}</strong>`, 'success');
    sendBtn.style.display = 'none';
    window.foundFile = null;
  } catch (err) {
    logEntry.status    = 'error';
    logEntry.error_msg = err.message;
    showStatus('❌ Failed to send: ' + err.message, 'error');
  }

  // Write to Supabase send_logs
  await window.sb.from('send_logs').insert(logEntry);

  sendBtn.disabled = false; sendBtn.innerHTML = '📤 Send to Client';
  searchBtn.disabled = false;

  // Refresh logs in background
  loadLogs();
}

// ════════════════════════════════════════════
//  DRIVE SEARCH
//  Path: My Drive → Audit Data → 2081.082 → Scan
//  Inside Scan there are 4 folders:
//    1. Devi Sir Sign
//    2. Lila Sir Sign
//    3. Sailesh Sir
//    4. Tax clearance
//  For ALL doc types except Tax Clearance → search all 3 sign folders
//  For Tax Clearance → search only the Tax clearance folder
// ════════════════════════════════════════════
async function searchDrive(clientName, docType, year) {
  // Step 1: Find "Audit Data" in My Drive root
  const auditDataId = await Integrations.findFolderByName(null, [
    'Audit Data', 'AUDIT DATA', 'audit data'
  ]);
  if (!auditDataId) throw new Error(
    'Could not find "Audit Data" folder in your Google Drive. Make sure the folder exists in My Drive.'
  );

  // Step 2: Find the year folder inside Audit Data
  // Covers every separator variation someone might use when naming the folder
  const yearFolderId = await Integrations.findFolderByName(auditDataId, [
    '2081.082',  '2081-082',  '2081/082',  '2081_082',  '2081 082',
    '2081.82',   '2081-82',   '2081/82',   '2081_82',   '2081 82',
    '2081082',
    '2082.083',  '2082-083',  '2082/083',  '2082_083',  // next year
  ]);
  if (!yearFolderId) throw new Error(
    'Could not find the year folder (e.g. "2081.082") inside "Audit Data". ' +
    'Make sure the folder name matches one of the expected formats.'
  );

  // Step 3: Find "Scan" folder inside the year folder
  const scanFolderId = await Integrations.findFolderByName(yearFolderId, [
    'Scan', 'SCAN', 'scan', 'Scans', 'SCANS'
  ]);
  if (!scanFolderId) throw new Error(
    'Could not find "Scan" folder inside the year folder.'
  );

  // Step 4: Resolve which subfolders to search based on doc type
  const dt = docType.toLowerCase();
  let searchFolderIds = [];

  if (dt === 'tax clearance') {
    // Tax Clearance → only look in the Tax clearance folder
    const tcId = await Integrations.findFolderByName(scanFolderId, [
      'Tax clearance', 'Tax Clearance', 'TAX CLEARANCE',
      'tax clearance', 'TaxClearance'
    ]);
    if (!tcId) throw new Error(
      'Could not find "Tax clearance" folder inside Scan. Check the folder name in Drive.'
    );
    searchFolderIds = [tcId];

  } else {
    // Audit Report / Financial Statements / VAT Returns / anything else
    // → search ALL THREE sign folders because files for all these doc types
    //   are stored inside them
    const signFolderVariants = [
      // Devi Sir
      ['Devi Sir Sign', 'Devi sir sign', 'DEVI SIR SIGN', 'Devi Sir', 'devi sir sign', 'Devi'],
      // Lila Sir
      ['Lila Sir Sign', 'Lila sir sign', 'LILA SIR SIGN', 'Lila Sir', 'lila sir sign', 'Lila'],
      // Sailesh Sir
      ['Sailesh Sir', 'sailesh sir', 'SAILESH SIR', 'Sailesh Sir Sign', 'Sailesh'],
    ];

    for (const variants of signFolderVariants) {
      const fid = await Integrations.findFolderByName(scanFolderId, variants);
      if (fid) {
        searchFolderIds.push(fid);
      } else {
        console.warn('Could not find sign folder:', variants[0]);
      }
    }

    if (searchFolderIds.length === 0) throw new Error(
      'Could not find any of the sign folders (Devi Sir Sign, Lila Sir Sign, Sailesh Sir) inside Scan. Check folder names in Drive.'
    );
  }

  // Step 5: Recursively list all files from the resolved folders
  let allFiles = [];
  for (const fid of searchFolderIds) {
    const files = await Integrations.listAllFilesInFolder(fid);
    allFiles = allFiles.concat(files);
  }

  if (allFiles.length === 0) throw new Error(
    `No files found in the ${docType} folder(s). Make sure files exist inside the correct subfolders.`
  );

  // Step 6: Smart fuzzy matching against client name
  const cn = clientName.toLowerCase().trim();
  const cnWords = cn.split(/\s+/).filter(w => w.length > 1);

  const scored = allFiles.map(file => {
    // Normalise filename: strip extension, replace underscores/dashes/dots with spaces
    const rawName = file.name.toLowerCase().replace(/\.[^.]+$/, '');
    const n = rawName.replace(/[_.\-]+/g, ' ');

    // Strip year-like patterns (e.g. "2081 082", "2081 82", "208182") from the
    // normalised name so they don't interfere with client name word matching
    const nNoYear = n.replace(/\b20\d{2}[\s._\-]?0?\d{2,3}\b/g, '').trim();

    let score = 0, clientMatch = false;

    // ── TIER 1: Exact substring match (highest confidence) ──
    if (nNoYear.includes(cn)) {
      score += 100; clientMatch = true;

    // ── TIER 2: All words present in filename ──
    } else if (cnWords.length > 0 && cnWords.every(w => nNoYear.includes(w))) {
      score += 80; clientMatch = true;

    } else {
      // ── TIER 3: Fuzzy word-level matching ──
      // For each word in client name, find best fuzzy match in filename words
      // Use year-stripped name so year digits don't confuse the matching
      const fileWords = nNoYear.split(/\s+/).filter(w => w.length > 1);
      let wordScore = 0;
      let strongMatches = 0;

      for (const cw of cnWords) {
        let bestSim = 0;
        for (const fw of fileWords) {
          const sim = stringSimilarity(cw, fw);
          if (sim > bestSim) bestSim = sim;
        }
        // sim > 0.75 = strong match (e.g. "supliers" vs "suppliers")
        // sim > 0.55 = weak match  (e.g. "areal" vs "aryal")
        if (bestSim > 0.75) { wordScore += bestSim * 20; strongMatches++; }
        else if (bestSim > 0.55) { wordScore += bestSim * 8; }
      }

      // Need at least 60% of client words to fuzzy-match strongly
      const strongRatio = strongMatches / cnWords.length;
      if (strongRatio >= 0.6) {
        score += wordScore;
        clientMatch = true;
      } else if (strongRatio >= 0.4 && wordScore > 10) {
        // Weak match — flag as warning
        score += wordScore * 0.5;
        clientMatch = true;
        file._warning = `Fuzzy match — please verify this is the correct file for "${clientName}"`;
      }
    }

    // ── BONUS: fiscal year in filename ──
    // Normalise BOTH the typed year and the filename year to digits-only
    // so 2081-82, 2081.082, 2081/082, 208182 all match each other
    if (year && clientMatch) {
      const digits = s => s.replace(/\D+/g, '');          // strip non-digits
      const yearDigits = digits(year);                     // "208182" or "2081082"
      const fileDigits = digits(rawName);                  // digits in filename

      // Try full year digits match OR short form (208182 inside 2081082)
      if (
        fileDigits.includes(yearDigits) ||
        yearDigits.includes(fileDigits.slice(0, 7))
      ) score += 15;
    }

    return { file, score, clientMatch };
  });

  const matches = scored.filter(s => s.clientMatch);
  if (matches.length === 0) return null;

  matches.sort((a, b) => b.score - a.score);
  return matches[0].file;
}

// ════════════════════════════════════════════
//  SEND EMAIL — composes the subject/body this tab uses, then delegates
//  the actual Drive-download + Gmail-send mechanics to Integrations
//  (js/core/integrations.js), which has no knowledge of doc types or
//  fiscal years.
// ════════════════════════════════════════════
async function sendEmail(file, clientName, docType, year, toEmail) {
  const customMsg = document.getElementById('emailMessage').value.trim();
  const bodyText = customMsg ||
    `Dear ${clientName},\n\nPlease find attached your ${docType}${year ? ' for the fiscal year ' + year : ''}.\n\nIf you have any questions, please do not hesitate to contact us.\n\nBest regards,\nAudit Team`;
  const subject = `${docType} — ${clientName}${year ? ' (' + year + ')' : ''}`;

  await Integrations.sendEmailWithAttachment({ file, toEmail, subject, bodyText });
}

function clearForm() {
  ['clientName','fiscalYear','clientEmail','emailMessage'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('docType').value = '';
  document.getElementById('status-area').innerHTML = '';
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('autocomplete-list').style.display = 'none';
  window.foundFile = null;
}

function clearFile() {
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('status-area').innerHTML = '';
  window.foundFile = null;
}
