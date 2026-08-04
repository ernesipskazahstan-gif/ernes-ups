/**
 * ERNES — офлайн-ядро для формы диагностики/ТО.
 * Хранит черновики и фото в IndexedDB, синхронизирует очередь на сервер
 * (Apps Script), когда появляется сеть. Не зависит от DOM формы — форма
 * вызывает публичные методы ErnesOffline.* и подписывается на onChange.
 *
 * Статусы черновика:
 *   'draft'   — не завершён (можно продолжить заполнение), не синхронизируется
 *   'pending' — отправлен инженером, ждёт синхронизации
 *   'syncing' — идёт отправка на сервер
 *   'done'    — успешно отправлен (есть serverActNumber)
 *   'error'   — ошибка отправки, останется в очереди для повтора
 *
 * Идемпотентность повтора: в d.sync хранится уже полученный № акта и folderId,
 * поэтому startAct не вызывается повторно; каждое фото помечается uploaded,
 * поэтому не грузится дважды; submit на бэкенде — upsert по № акта.
 */
var ErnesOffline = (function () {
  var DB_NAME = 'ernes_field';
  var DB_VERSION = 1;
  var STORE_DRAFTS = 'drafts';
  var STORE_PHOTOS = 'photos';

  var endpoint = null;      // URL Apps Script (.../exec)
  var dbPromise = null;
  var isSyncing = false;
  var changeCb = null;      // форма подписывается для обновления бейджа/списка

  function setEndpoint(url) { endpoint = url; }
  function onChange(cb) { changeCb = cb; }
  function fireChange() { if (changeCb) { try { changeCb(); } catch (e) {} } }

  /* ===================== IndexedDB ===================== */
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
          db.createObjectStore(STORE_DRAFTS, { keyPath: 'localId' });
        }
        if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
          var ps = db.createObjectStore(STORE_PHOTOS, { keyPath: 'photoId' });
          ps.createIndex('byLocalId', 'localId', { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(storeNames, mode) {
    return openDB().then(function (db) {
      return db.transaction(storeNames, mode);
    });
  }
  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ===================== Черновики ===================== */
  function newLocalId() {
    return 'L' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }

  // Сохраняет незавершённый черновик (raw state для «Продолжить»).
  function saveDraftState(localId, mode, snapshot) {
    return getDraft(localId).then(function (existing) {
      var d = existing || { localId: localId, createdAt: Date.now() };
      d.mode = mode;
      d.state = snapshot;                       // raw для восстановления
      if (!d.status || d.status === 'draft') d.status = 'draft';
      return putDraft(d);
    });
  }

  // Финализирует черновик к отправке: сохраняет готовый payload + статус pending.
  function finalizeDraft(localId, mode, snapshot, payload) {
    return getDraft(localId).then(function (existing) {
      var d = existing || { localId: localId, createdAt: Date.now() };
      d.mode = mode;
      d.state = snapshot;
      d.payload = payload;                      // готово к submit (без № акта/folderUrl)
      d.status = 'pending';
      d.finalizedAt = Date.now();
      return putDraft(d);
    });
  }

  function putDraft(d) {
    return tx([STORE_DRAFTS], 'readwrite').then(function (t) {
      var p = reqToPromise(t.objectStore(STORE_DRAFTS).put(d));
      return p.then(function () { fireChange(); return d; });
    });
  }
  function getDraft(localId) {
    return tx([STORE_DRAFTS], 'readonly').then(function (t) {
      return reqToPromise(t.objectStore(STORE_DRAFTS).get(localId));
    });
  }
  function allDrafts() {
    return tx([STORE_DRAFTS], 'readonly').then(function (t) {
      return reqToPromise(t.objectStore(STORE_DRAFTS).getAll());
    }).then(function (list) {
      list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return list;
    });
  }
  function deleteDraft(localId) {
    return tx([STORE_DRAFTS, STORE_PHOTOS], 'readwrite').then(function (t) {
      t.objectStore(STORE_DRAFTS).delete(localId);
      var idx = t.objectStore(STORE_PHOTOS).index('byLocalId');
      return new Promise(function (resolve) {
        var cur = idx.openCursor(IDBKeyRange.only(localId));
        cur.onsuccess = function (e) {
          var c = e.target.result;
          if (c) { c.delete(); c.continue(); } else resolve();
        };
        cur.onerror = function () { resolve(); };
      });
    }).then(function () { fireChange(); });
  }

  function countQueued() {
    return allDrafts().then(function (list) {
      return list.filter(function (d) { return d.status === 'pending' || d.status === 'error' || d.status === 'syncing'; }).length;
    });
  }

  /* ===================== Фото ===================== */
  function addPhoto(localId, group, blob, mime, fileName) {
    var rec = {
      photoId: 'P' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      localId: localId,
      group: group || 'Общие фото',
      fileName: fileName || (String(group || 'photo').replace(/[\s\/]+/g, '_') + '_' + Date.now() + '.jpg'),
      mime: mime || 'image/jpeg',
      blob: blob,
      uploaded: false,
      driveFileId: null
    };
    return tx([STORE_PHOTOS], 'readwrite').then(function (t) {
      return reqToPromise(t.objectStore(STORE_PHOTOS).put(rec));
    }).then(function () { fireChange(); return rec; });
  }
  function getPhotos(localId) {
    return tx([STORE_PHOTOS], 'readonly').then(function (t) {
      var idx = t.objectStore(STORE_PHOTOS).index('byLocalId');
      return reqToPromise(idx.getAll(IDBKeyRange.only(localId)));
    });
  }
  function savePhoto(rec) {
    return tx([STORE_PHOTOS], 'readwrite').then(function (t) {
      return reqToPromise(t.objectStore(STORE_PHOTOS).put(rec));
    });
  }
  function deletePhoto(photoId) {
    return tx([STORE_PHOTOS], 'readwrite').then(function (t) {
      return reqToPromise(t.objectStore(STORE_PHOTOS).delete(photoId));
    }).then(function () { fireChange(); });
  }
  function photoCount(localId) {
    return getPhotos(localId).then(function (list) { return list.length; });
  }

  /* ===================== Сеть ===================== */
  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function callPost(action, data, timeoutMs) {
    if (!endpoint) return Promise.reject(new Error('endpoint не задан'));
    var body = Object.assign({ action: action }, data || {});
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 45000) : null;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error(res.error || 'Ошибка сервера');
      return res.data;
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('превышено время ожидания сети');
      throw err;
    });
  }

  /* ===================== Синхронизация ===================== */
  function syncDraft(d) {
    d.status = 'syncing'; d.error = null;
    return putDraft(d).then(function () {
      // 1) № акта + папка (только если ещё не получены)
      if (!d.sync || !d.sync.serverActNumber) {
        var client = (d.payload && d.payload.client) || (d.state && d.state.form && d.state.form.client) || '';
        return callPost('startAct', { client: client, mode: d.mode, localId: d.localId }).then(function (r) {
          d.sync = { serverActNumber: r.actNumber, folderId: r.folderId, folderUrl: r.folderUrl };
          return putDraft(d);
        });
      }
    }).then(function () {
      // 2) фото пачкой (только не загруженные)
      return getPhotos(d.localId).then(function (photos) {
        var chain = Promise.resolve();
        photos.forEach(function (p) {
          if (p.uploaded) return;
          chain = chain.then(function () {
            return blobToB64(p.blob).then(function (b64) {
              return callPost('uploadPhoto', {
                base64: b64, fileName: p.fileName, folderId: d.sync.folderId, mimeType: p.mime, group: p.group
              }, 90000).then(function (pr) {
                p.uploaded = true; p.driveFileId = pr.fileId;
                return savePhoto(p);
              });
            });
          });
        });
        return chain;
      });
    }).then(function () {
      // 3) запись акта (upsert по № акта на бэкенде)
      var payload = Object.assign({}, d.payload, {
        actNumber: d.sync.serverActNumber,
        folderUrl: d.sync.folderUrl
      });
      var action = (d.mode === 'to') ? 'submitMaintenance' : 'submitDiagnostic';
      return callPost(action, { payload: payload });
    }).then(function () {
      d.status = 'done';
      d.serverActNumber = d.sync.serverActNumber;
      d.syncedAt = Date.now();
      return putDraft(d);
    }).catch(function (err) {
      d.status = 'error';
      d.error = String(err && err.message ? err.message : err);
      return putDraft(d).then(function () { throw err; });
    });
  }

  // Реанимирует «осиротевшие» черновики: статус 'syncing', оставшийся с прошлой
  // сессии (приложение закрыли/обновили во время отправки), переводит обратно
  // в 'pending', иначе он застрял бы навсегда — очередь его не берёт.
  function reclaimStuck() {
    return allDrafts().then(function (list) {
      var chain = Promise.resolve();
      list.forEach(function (d) {
        if (d.status === 'syncing') {
          chain = chain.then(function () { d.status = 'pending'; d.error = null; return putDraft(d); });
        }
      });
      return chain;
    });
  }

  // Синхронизирует все pending/error по очереди (последовательно).
  function syncAll() {
    if (isSyncing) return Promise.resolve({ skipped: true });
    if (!navigator.onLine) return Promise.resolve({ offline: true });
    isSyncing = true;
    return reclaimStuck().then(allDrafts).then(function (list) {
      var queue = list.filter(function (d) { return d.status === 'pending' || d.status === 'error'; });
      var okCount = 0, failCount = 0;
      var chain = Promise.resolve();
      queue.forEach(function (d) {
        chain = chain.then(function () {
          return syncDraft(d).then(function () { okCount++; }, function () { failCount++; });
        });
      });
      return chain.then(function () { return { ok: okCount, failed: failCount, total: queue.length }; });
    }).then(function (res) {
      isSyncing = false; fireChange(); return res;
    }, function (err) {
      isSyncing = false; fireChange(); throw err;
    });
  }

  // Пытается синхронизировать, если онлайн и не занято (для авто-триггеров).
  function trySync() {
    if (!navigator.onLine || isSyncing) return Promise.resolve(null);
    return syncAll();
  }

  // Регистрируем авто-синхронизацию при появлении сети.
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () { trySync(); });
  }

  return {
    setEndpoint: setEndpoint,
    onChange: onChange,
    newLocalId: newLocalId,
    saveDraftState: saveDraftState,
    finalizeDraft: finalizeDraft,
    getDraft: getDraft,
    allDrafts: allDrafts,
    deleteDraft: deleteDraft,
    countQueued: countQueued,
    addPhoto: addPhoto,
    getPhotos: getPhotos,
    deletePhoto: deletePhoto,
    photoCount: photoCount,
    syncAll: syncAll,
    trySync: trySync,
    isSyncing: function () { return isSyncing; }
  };
})();
