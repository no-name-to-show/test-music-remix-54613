/**
 * MixMaker · Project persistence primitives.
 * IndexedDB database opening and serializable project snapshots.
 */
export function createProjectDatabase() {
  let database = null;

  function openDatabase() {
    if (database) return Promise.resolve(database);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB no está disponible (¿modo privado?).'));
        return;
      }
      const request = indexedDB.open('mix-maker-v2', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
  }

  return { openDatabase };
}

export function serializeProject(state) {
  return {
    app: 'mix-maker',
    version: 2,
    name: state.name,
    trans: state.trans,
    zoom: state.zoom,
    snap: state.snap,
    tracks: state.tracks,
    assets: state.assets.map(asset => ({
      id: asset.id,
      name: asset.name,
      fileName: asset.fileName,
      size: asset.size,
      duration: asset.duration
    }))
  };
}
