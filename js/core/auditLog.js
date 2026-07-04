// ════════════════════════════════════════════
//  AUDIT LOG
//  Cross-cutting event record — document generation and OCR extraction
//  jobs today, any future module's own events later. Distinct from
//  logs.js's Send Logs (which is specifically the Send Document feature's
//  email-send history) — this is the general activity log the Dashboard
//  reads from. Every call is best-effort: a logging failure must never
//  break the actual feature that triggered it.
// ════════════════════════════════════════════
window.AuditLog = (function () {
  async function record(eventType, detail) {
    try {
      const { error } = await window.sb.from('audit_log').insert({
        event_type: eventType,
        module: (detail && detail.module) || null,
        status: (detail && detail.status) || 'success',
        user_email: (window.currentUser && window.currentUser.email) || null,
        client_name: (detail && detail.clientName) || null,
        detail: detail || {},
      });
      if (error) console.error('AuditLog: failed to record event', eventType, error.message);
    } catch (e) {
      console.error('AuditLog: failed to record event', eventType, e);
    }
  }

  async function recent(limit) {
    try {
      const { data, error } = await window.sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit || 10);
      return error ? [] : (data || []);
    } catch (e) {
      return [];
    }
  }

  async function countSince(eventType, sinceIso) {
    try {
      const { count, error } = await window.sb.from('audit_log').select('id', { count: 'exact', head: true }).eq('event_type', eventType).gte('created_at', sinceIso);
      return error ? 0 : (count || 0);
    } catch (e) {
      return 0;
    }
  }

  return { record, recent, countSince };
})();
