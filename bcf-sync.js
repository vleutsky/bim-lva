/**
 * BCF-заметки в Supabase: блокнот на набор моделей, обмен по share_code.
 */
(function (global) {
  'use strict';

  const LS_PREFIX = 'bimlva_bcf_nb_v1_';

  function modelStorageKey(modelKey) {
    let h = 0;
    const s = String(modelKey || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return LS_PREFIX + (h >>> 0).toString(16);
  }

  function authReady() {
    const auth = global.BimLvaAuth;
    return auth && auth.mode() === 'supabase' && auth.getUser();
  }

  async function client() {
    const auth = global.BimLvaAuth;
    if (!authReady()) return null;
    return auth.getSupabaseClient();
  }

  async function ensureNotebook(modelKey, title) {
    const sb = await client();
    const user = global.BimLvaAuth.getUser();
    if (!sb || !user || !modelKey) return null;

    const lsKey = modelStorageKey(modelKey);
    const storedId = localStorage.getItem(lsKey);
    if (storedId) {
      const { data: nb, error } = await sb
        .from('bcf_notebooks')
        .select('id, share_code, title')
        .eq('id', storedId)
        .maybeSingle();
      if (!error && nb) return nb;
      localStorage.removeItem(lsKey);
    }

    const { data: owned, error: findErr } = await sb
      .from('bcf_notebooks')
      .select('id, share_code, title')
      .eq('owner_id', user.id)
      .eq('model_key', modelKey)
      .maybeSingle();
    if (!findErr && owned) {
      localStorage.setItem(lsKey, owned.id);
      return owned;
    }

    const { data: created, error: insErr } = await sb
      .from('bcf_notebooks')
      .insert({
        title: title || 'Заметки',
        owner_id: user.id,
        model_key: modelKey
      })
      .select('id, share_code, title')
      .single();
    if (insErr) throw insErr;
    localStorage.setItem(lsKey, created.id);
    return created;
  }

  async function joinByShareCode(code) {
    const sb = await client();
    if (!sb) throw new Error('Войдите в аккаунт (Supabase).');
    const { data, error } = await sb.rpc('join_bcf_notebook', { p_share_code: String(code || '').trim() });
    if (error) {
      if (error.message?.includes('not_found')) throw new Error('Код не найден');
      if (error.message?.includes('not_authenticated')) throw new Error('Сначала войдите в аккаунт');
      throw error;
    }
    return data;
  }

  async function loadTopics(notebookId) {
    const sb = await client();
    if (!sb || !notebookId) return [];
    const { data, error } = await sb
      .from('bcf_notebook_topics')
      .select('id, topic_guid, payload, author_email, created_at')
      .eq('notebook_id', notebookId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data || []).map(row => {
      const t = { ...row.payload };
      t._cloudRowId = row.id;
      if (row.author_email && !t.authorEmail) t.authorEmail = row.author_email;
      return t;
    });
  }

  async function insertTopic(notebookId, topic) {
    const sb = await client();
    const user = global.BimLvaAuth.getUser();
    if (!sb || !user) return null;
    const { data, error } = await sb
      .from('bcf_notebook_topics')
      .insert({
        notebook_id: notebookId,
        topic_guid: topic.guid,
        payload: topic,
        author_id: user.id,
        author_email: user.email
      })
      .select('id')
      .single();
    if (error) throw error;
    return data?.id || null;
  }

  async function deleteTopic(cloudRowId) {
    const sb = await client();
    if (!sb || !cloudRowId) return;
    const { error } = await sb.from('bcf_notebook_topics').delete().eq('id', cloudRowId);
    if (error) throw error;
  }

  function rememberNotebook(modelKey, notebookId) {
    if (modelKey && notebookId) localStorage.setItem(modelStorageKey(modelKey), notebookId);
  }

  async function fetchNotebook(notebookId) {
    const sb = await client();
    if (!sb || !notebookId) return null;
    const { data, error } = await sb
      .from('bcf_notebooks')
      .select('id, share_code, title')
      .eq('id', notebookId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  global.BimLvaBcfSync = {
    authReady,
    ensureNotebook,
    fetchNotebook,
    joinByShareCode,
    loadTopics,
    insertTopic,
    deleteTopic,
    rememberNotebook
  };
})(typeof window !== 'undefined' ? window : globalThis);
