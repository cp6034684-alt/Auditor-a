// ==========================================
// 1. CONFIGURACIÓN DE FIREBASE CLOUD
// Offline-first: la app funciona sin Firebase.
// Cuando se configura, sincroniza automáticamente.
// ==========================================

// Leer credenciales guardadas por el usuario (desde Ajustes)
const _fbCfgGuardada = (() => {
  try { return JSON.parse(localStorage.getItem('firebaseConfig') || 'null'); } catch(_) { return null; }
})();

let db = null;
let _fbConectado = false;

function inicializarFirebase(config) {
  if (!config || !config.apiKey || config.apiKey === 'TU_API_KEY') return false;
  try {
    let app;
    if (firebase.apps.length > 0) {
      app = firebase.apps[0];
      if (app.options.projectId !== config.projectId) {
        alert('Para cambiar de proyecto Firebase necesitas recargar la página primero (F5).');
        return false;
      }
    } else {
      app = firebase.initializeApp(config);
    }

    const firestoreInstance = firebase.firestore(app);
    db = firestoreInstance;

    // enablePersistence PRIMERO, luego activar listeners cuando esté lista
    firestoreInstance.enablePersistence({ synchronizeTabs: true })
      .then(() => {
        console.log('Persistencia offline activa ✅');
        activarListenersFirebase();
      })
      .catch(err => {
        if (err.code === 'failed-precondition') {
          // Múltiples pestañas — solo una puede tener persistencia, pero sincroniza igual
          console.warn('Múltiples pestañas: persistencia en solo una pestaña.');
        } else if (err.code === 'unimplemented') {
          console.warn('Navegador sin soporte de persistencia offline.');
        } else {
          console.warn('enablePersistence error:', err.code);
        }
        // Activar listeners de todas formas aunque falle la persistencia
        activarListenersFirebase();
      });

    return true;
  } catch(e) {
    console.warn('Firebase no pudo inicializarse:', e.message);
    return false;
  }
}

// Intentar inicializar con config guardada
if (_fbCfgGuardada) {
  inicializarFirebase(_fbCfgGuardada);
}

// ==========================================
// 2. ESTADO GLOBAL Y ALMACENAMIENTO LOCAL
// ==========================================
let distriRaw = JSON.parse(localStorage.getItem("distribuidores")) || ["Distribuidora Central", "Aliados TAT"];
// ATENCIÓN: El objeto Distribuidor ahora tiene un array para sus marcas asignadas ("marcasAsignadas")
let distribuidores = distriRaw.map(d => typeof d === 'string' ? { 
  id: Date.now() + Math.random(), 
  nombre: d, 
  ciudad: "", 
  direccion: "", 
  vendedores: "", 
  clientes: "", 
  supervisores: [],
  marcasAsignadas: [] // Nueva propiedad relacional
} : d);

let vendedores = JSON.parse(localStorage.getItem("vendedoresObj")) || [];

// Las marcas vuelven a ser solo Strings Globales
let marcasRaw = JSON.parse(localStorage.getItem("marcas")) || ["Suerox", "Tío Nacho", "Cicatricure", "Xray", "Genoprazol", "Duracell"];
let marcas = marcasRaw.map(m => typeof m === 'object' ? m.nombre : m);

let visitas = JSON.parse(localStorage.getItem("visitas")) || [];
let notasGlobales = JSON.parse(localStorage.getItem("notasGlobales")) || [];
let googleCalendarId = localStorage.getItem("gcalId") || "";
let geminiApiKey = localStorage.getItem("geminiKey") || ""; 

// DATOS DE INICIO DE DÍA
let datoDiario = JSON.parse(localStorage.getItem("datoDiario_" + new Date().toISOString().split('T')[0])) || null;

// INFORMES GUARDADOS
let informesGuardados = JSON.parse(localStorage.getItem("informesGuardados")) || [];

// DATOS EDITABLES HISTORIAL (por sesion de distribuidor+vendedor+fecha)
let datosHistorialEdit = JSON.parse(localStorage.getItem("datosHistorialEdit")) || {};

// HUB DISTRIBUIDORES
let tareasDistrib = JSON.parse(localStorage.getItem("tareasDistrib")) || {};
let cuotasDistrib = JSON.parse(localStorage.getItem("cuotasDistrib")) || {};
let incentivosDistrib = JSON.parse(localStorage.getItem("incentivosDistrib")) || {};
let _periodoDistrib = 'semana';

const materialesPOP = ["Pastillero Genomma", "Ganchera Pilas Duracell"];
const aspectosDiarios = [ "Buena presentación personal (Uniforme)", "Porta herramientas (Catálogo/Tablet)" ];
const aspectosVisita = [ "1. Saludo e introducción cordial", "2. Posicionamiento (Soluciones icónicas)", "3. Reconocimiento de Marcas", "4. Apertura comercial (Ayuda a ganar más)", "5. Despedida icónica" ];

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = 55000;      // Más tiempo para análisis complejos
const GEMINI_MAX_OUTPUT_TOKENS = 2048; // Respuestas completas por defecto

// ==========================================
// MOTOR IA CENTRAL — llamarGemini()
// Todas las funciones de IA usan este único punto de entrada.
// Incluye: timeout, reintento automático, validación de respuesta,
// indicador de estado y mensajes de error descriptivos.
// ==========================================
function setIAStatus(estado) {
  // estados: 'idle' | 'loading' | 'ok' | 'error'
  const badge = document.getElementById('ia-status-badge');
  const txt   = document.getElementById('ia-status-txt');
  if (!badge || !txt) return;
  const config = {
    idle:    { icon: 'fa-robot',        label: 'IA —',          bg: 'rgba(255,255,255,0.15)', color: 'white' },
    loading: { icon: 'fa-spinner fa-spin', label: 'IA procesando…', bg: '#fff3cd',            color: '#856404' },
    ok:      { icon: 'fa-check-circle', label: 'IA lista',      bg: '#d4edda',              color: '#155724' },
    error:   { icon: 'fa-exclamation-triangle', label: 'IA falló', bg: '#f8d7da',            color: '#721c24' }
  };
  const c = config[estado] || config.idle;
  badge.style.background = c.bg;
  badge.style.color      = c.color;
  txt.innerHTML = `<i class="fas ${c.icon}"></i> ${c.label}`;
}

async function llamarGemini({ prompt, imageBase64 = null, maxRetries = 2, maxTokens = null }) {
  if (!geminiApiKey) {
    throw new Error('API Key no configurada. Ve a Ajustes → Motor IA para ingresarla.');
  }

  setIAStatus('loading');

  const partes = [{ text: prompt }];
  if (imageBase64) {
    partes.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
  }

  const body = JSON.stringify({
    contents: [{ parts: partes }],
    generationConfig: {
      maxOutputTokens: maxTokens || GEMINI_MAX_OUTPUT_TOKENS,
      temperature: 0.4   // Más preciso y detallado, menos genérico
    }
  });

  let ultimoError = null;

  for (let intento = 0; intento <= maxRetries; intento++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${GEMINI_ENDPOINT}?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal
        }
      );
      clearTimeout(timer);

      // ── Errores HTTP con mensajes descriptivos ──────────────────
      if (!response.ok) {
        const status = response.status;
        let bodyErr = '';
        try { bodyErr = (await response.json()).error?.message || ''; } catch(_) {}

        if (status === 400) throw new Error(`Solicitud inválida (400). ${bodyErr}`);
        if (status === 401 || status === 403) throw new Error(`API Key inválida o sin permisos (${status}). Revisa tu clave en Ajustes.`);
        if (status === 429) {
          // Rate limit → esperar y reintentar
          const wait = (intento + 1) * 3000;
          ultimoError = new Error(`Límite de uso alcanzado (429). Reintentando en ${wait/1000}s…`);
          setIAStatus('loading');
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (status === 503 || status === 500) {
          const wait = 2000;
          ultimoError = new Error(`Servicio de IA no disponible (${status}). Reintentando…`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`Error del servidor IA (${status}). ${bodyErr}`);
      }

      const data = await response.json();

      // ── Validación robusta de la respuesta ─────────────────────
      if (!data.candidates || data.candidates.length === 0) {
        const razon = data.promptFeedback?.blockReason || 'desconocida';
        throw new Error(`La IA bloqueó la respuesta (razón: ${razon}). Intenta reformular el contenido.`);
      }

      const candidato = data.candidates[0];
      const finishReason = candidato.finishReason;

      if (finishReason === 'SAFETY') {
        throw new Error('La IA bloqueó la respuesta por filtros de seguridad. Simplifica el contenido.');
      }
      if (finishReason === 'RECITATION') {
        throw new Error('La IA no pudo responder por restricciones de contenido.');
      }
      if (finishReason === 'MAX_TOKENS') {
        // Respuesta truncada pero usable — continuar con lo que llegó
        console.warn('Respuesta truncada por MAX_TOKENS, usando texto parcial.');
      }

      const texto = candidato?.content?.parts?.[0]?.text;
      if (!texto || texto.trim() === '') {
        throw new Error('La IA devolvió una respuesta vacía. Intenta de nuevo.');
      }

      setIAStatus('ok');
      return texto;

    } catch (err) {
      clearTimeout(timer);

      if (err.name === 'AbortError') {
        ultimoError = new Error(`Sin respuesta después de ${GEMINI_TIMEOUT_MS / 1000}s. Verifica tu conexión a internet.`);
        if (intento < maxRetries) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
      } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('net::')) {
        ultimoError = new Error('Sin conexión a internet. Verifica tu red y vuelve a intentarlo.');
        if (intento < maxRetries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      } else {
        // Error definitivo — no reintentar
        setIAStatus('error');
        throw err;
      }
    }
  }

  // Agotados los reintentos
  setIAStatus('error');
  throw ultimoError || new Error('La IA no respondió después de varios intentos. Intenta más tarde.');
}

function textoAHtml(texto) {
  return texto
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\n/g, '<li>$1</li>')
    .replace(/\n/g, '<br>');
}

function truncar(texto, max) {
  if (!texto) return '';
  return texto.length > max ? texto.substring(0, max) + '…' : texto;
}

const getHoy = () => { 
  const d = new Date(); 
  return new Date(d.getTime() - (d.getTimezoneOffset() * 60000)).toISOString().split('T')[0]; 
};
const getMesActual = () => getHoy().substring(0, 7); 

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('fecha-filtro').value = getHoy(); 
  document.getElementById('filtro-stat-dia').value = getHoy();
  document.getElementById('filtro-stat-mes').value = getMesActual(); 
  document.getElementById('filtro-stat-inicio').value = getHoy(); 
  document.getElementById('filtro-stat-fin').value = getHoy();
  document.getElementById('filtro-informes-fecha') && (document.getElementById('filtro-informes-fecha').value = getHoy());
  
  if (!db) {
    const statusEl = document.getElementById('nube-status');
    if (statusEl) {
      statusEl.innerHTML = '<i class="fas fa-mobile-alt"></i> Modo Local — configura Firebase en Ajustes para sincronizar';
    }
  } else {
    // Monitorear conectividad en tiempo real
    const statusEl = document.getElementById('nube-status');
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Conectando…';
  }

  // Aplicar tema guardado (modo oscuro)
  const temaGuardado = localStorage.getItem('tema') || 'light';
  aplicarTema(temaGuardado);

  // Restaurar estado del formulario al cargar (fix bug pérdida de datos)
  restoreFormState();
  
  // Mostrar estado del botón de inicio de ruta
  setTimeout(actualizarBtnInicioRuta, 300);

  // Inicializar badge IA
  if (geminiApiKey) {
    setIAStatus('ok');
  } else {
    setIAStatus('idle');
  }
  
  // Agregar listeners de persistencia a todos los campos del formulario
  ['zona', 'tienda', 'notas-visita', 'comentario-general-auditoria'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', saveFormState);
  });
  ['distribuidor', 'vendedor'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveFormState);
  });
});

let charInstanciaMarcas = null; 
let charInstanciaTacticas = null; 
let charInstanciaDiaria = null;
let fotoBase64AI = null; 
let fotoMinBase64 = null; 
let supervisoresTemp = [];
let voiceRecognition = null; 
let isRecordingGlobal = false;

// BANDERAS DE EDICIÓN
let editandoDistribuidorId = null; 
let editandoVendedorId = null;     

// ==========================================
// 3. SINCRONIZACIÓN EN TIEMPO REAL CON FIREBASE
// Offline-first: Firestore con persistencia offline activa.
// Los cambios locales se guardan inmediatamente y se sincronizan
// cuando hay conexión. El status indica el estado real.
// ==========================================
function actualizarStatusNube(estado) {
  _fbConectado = (estado === 'online');

  // Si el DOM aún no está listo, diferir la actualización visual
  const statusEl = document.getElementById('nube-status');
  if (!statusEl) {
    document.addEventListener('DOMContentLoaded', () => actualizarStatusNube(estado), { once: true });
    return;
  }

  const estados = {
    local:    { icon: 'fa-mobile-alt',          msg: 'Solo local — configura Firebase en Ajustes',              color: '#ffe082' },
    online:   { icon: 'fa-check-circle',         msg: '☁️ Sincronizado con la nube',                            color: '#d4edda' },
    offline:  { icon: 'fa-wifi',                 msg: 'Sin conexión — guardando localmente',                    color: '#ffe082', tachado: true },
    permisos: { icon: 'fa-exclamation-triangle', msg: '⚠️ Reglas Firestore vencidas — ve a Ajustes',           color: '#f8d7da' },
    error:    { icon: 'fa-times-circle',         msg: 'Error Firebase — verifica las credenciales en Ajustes',  color: '#f8d7da' }
  };

  if (!db) estado = 'local';
  const cfg = estados[estado] || estados.local;
  const tachado = cfg.tachado ? ' style="text-decoration:line-through;"' : '';
  statusEl.innerHTML = `<i class="fas ${cfg.icon}"${tachado}></i> ${cfg.msg}`;
  statusEl.style.color = cfg.color;

  if (estado === 'permisos' && !window._permisosAlertaMostrada) {
    window._permisosAlertaMostrada = true;
    setTimeout(() => {
      showToast('⚠️ Reglas Firebase vencidas. Ve a Ajustes → Firebase para ver instrucciones.');
      const alertaEl = document.getElementById('alerta-reglas-firestore');
      if (alertaEl) alertaEl.style.display = 'block';
    }, 800);
  }
}

function activarListenersFirebase() {
  if (!db) return;

  // Monitor de conectividad del navegador
  window.addEventListener('online',  () => actualizarStatusNube('online'));
  window.addEventListener('offline', () => actualizarStatusNube('offline'));

  // Test de conectividad: leer (no escribir) distribuidores para verificar permisos.
  // Evita crear colecciones extra (_ping) que pueden fallar con reglas restrictivas.
  db.collection("distribuidores").limit(1).get()
    .then(() => { actualizarStatusNube('online'); })
    .catch(err => {
      if (err.code === 'permission-denied') actualizarStatusNube('permisos');
      else actualizarStatusNube('offline');
    });

  // NOTA sobre hasPendingWrites: NO filtramos por hasPendingWrites aquí.
  // Esa propiedad se evalúa a nivel de colección completa y bloquearía snapshots
  // legítimos del servidor. Los datos de Firestore siempre son la fuente de verdad.
  // includeMetadataChanges:true → detectamos cuando datos pasan cache→servidor.

  // ── Distribuidores ──
  db.collection("distribuidores").onSnapshot(
    { includeMetadataChanges: true },
    (querySnapshot) => {
      // Solo procesar cuando el servidor confirma (no solo caché propia)
      if (querySnapshot.metadata.fromCache && querySnapshot.metadata.hasPendingWrites) return;
      const nuevosDatos = querySnapshot.docs.map(doc => doc.data());
      // Evitar sobrescribir si el servidor devuelve vacío y tenemos datos locales
      if (nuevosDatos.length === 0 && distribuidores.length > 0 && querySnapshot.metadata.fromCache) return;
      distribuidores = nuevosDatos;
      localStorage.setItem("distribuidores", JSON.stringify(distribuidores));
      renderizarApp();
      if (!querySnapshot.metadata.fromCache) actualizarStatusNube('online');
    },
    (error) => {
      if (error.code === 'permission-denied') actualizarStatusNube('permisos');
      else actualizarStatusNube('offline');
    }
  );

  // ── Vendedores ──
  db.collection("vendedores").onSnapshot(
    { includeMetadataChanges: true },
    (querySnapshot) => {
      if (querySnapshot.metadata.fromCache && querySnapshot.metadata.hasPendingWrites) return;
      const nuevosDatos = querySnapshot.docs.map(doc => doc.data());
      if (nuevosDatos.length === 0 && vendedores.length > 0 && querySnapshot.metadata.fromCache) return;
      vendedores = nuevosDatos;
      localStorage.setItem("vendedoresObj", JSON.stringify(vendedores));
      renderizarApp();
    },
    (error) => console.warn('Vendedores sync error:', error.code)
  );

  // ── Marcas ──
  db.collection("marcas").doc("globales").onSnapshot(
    { includeMetadataChanges: true },
    (doc) => {
      if (doc.metadata.fromCache && doc.metadata.hasPendingWrites) return;
      if (doc.exists) {
        const nuevasMarcas = doc.data().lista || [];
        if (nuevasMarcas.length === 0 && marcas.length > 0 && doc.metadata.fromCache) return;
        marcas = nuevasMarcas;
        localStorage.setItem("marcas", JSON.stringify(marcas));
        renderizarApp();
      }
    },
    (error) => console.warn('Marcas sync error:', error.code)
  );

  // ── Visitas ──
  db.collection("visitas").onSnapshot(
    { includeMetadataChanges: true },
    (querySnapshot) => {
      if (querySnapshot.metadata.fromCache && querySnapshot.metadata.hasPendingWrites) return;
      const nuevasVisitas = querySnapshot.docs.map(doc => doc.data());
      if (nuevasVisitas.length === 0 && visitas.length > 0 && querySnapshot.metadata.fromCache) return;
      visitas = nuevasVisitas;
      localStorage.setItem("visitas", JSON.stringify(visitas));
      if (document.getElementById('view-calendar')?.classList.contains('active')) mostrarRegistrosPorFecha();
      if (document.getElementById('view-stats')?.classList.contains('active')) actualizarEstadisticas();
    },
    (error) => console.warn('Visitas sync error:', error.code)
  );

  // ── Notas ──
  db.collection("notas").onSnapshot(
    { includeMetadataChanges: true },
    (querySnapshot) => {
      if (querySnapshot.metadata.fromCache && querySnapshot.metadata.hasPendingWrites) return;
      const nuevasNotas = querySnapshot.docs.map(doc => doc.data());
      if (nuevasNotas.length === 0 && notasGlobales.length > 0 && querySnapshot.metadata.fromCache) return;
      notasGlobales = nuevasNotas;
      localStorage.setItem("notasGlobales", JSON.stringify(notasGlobales));
      if (document.getElementById('view-voice')?.classList.contains('active')) renderizarNotasGlobales();
    },
    (error) => console.warn('Notas sync error:', error.code)
  );
}

// Los listeners se activan desde inicializarFirebase() al terminar enablePersistence.
// Si Firebase no está configurado, mostrar status local.
if (!db) {
  setTimeout(() => actualizarStatusNube('local'), 200);
}

// ==========================================
// 4. CONFIGURACIÓN Y MIGRACIÓN FIREBASE
// ==========================================
function guardarConfigFirebase() {
  const apiKey           = document.getElementById('fb-api-key')?.value.trim();
  const authDomain       = document.getElementById('fb-auth-domain')?.value.trim();
  const projectId        = document.getElementById('fb-project-id')?.value.trim();
  const storageBucket    = document.getElementById('fb-storage-bucket')?.value.trim();
  const messagingSenderId= document.getElementById('fb-messaging-sender-id')?.value.trim();
  const appId            = document.getElementById('fb-app-id')?.value.trim();

  if (!apiKey || !projectId || !appId) {
    return alert('API Key, Project ID y App ID son obligatorios.');
  }

  const config = { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId };
  localStorage.setItem('firebaseConfig', JSON.stringify(config));

  const ok = inicializarFirebase(config);
  const statusEl = document.getElementById('fb-status-msg');
  if (ok) {
    showToast('Firebase configurado ✅ — conectando…');
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-circle-notch fa-spin" style="color:#F57C00;"></i> Conectando a Firebase…';
  } else {
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-times-circle" style="color:#dc3545;"></i> Error al conectar. Verifica los datos ingresados.';
    alert('No se pudo conectar a Firebase. Verifica que los valores sean correctos y que Firestore esté habilitado en tu proyecto.');
  }
}

function cargarConfigFirebaseEnFormulario() {
  const cfg = (() => { try { return JSON.parse(localStorage.getItem('firebaseConfig') || 'null'); } catch(_){return null;} })();
  if (!cfg) return;

  const mapCampos = {
    'fb-api-key':              'apiKey',
    'fb-auth-domain':          'authDomain',
    'fb-project-id':           'projectId',
    'fb-storage-bucket':       'storageBucket',
    'fb-messaging-sender-id':  'messagingSenderId',
    'fb-app-id':               'appId'
  };
  Object.entries(mapCampos).forEach(([elId, cfgKey]) => {
    const el = document.getElementById(elId);
    if (el && cfg[cfgKey]) el.value = cfg[cfgKey];
  });

  const statusEl = document.getElementById('fb-status-msg');
  if (statusEl) {
    if (db) {
      statusEl.innerHTML = '<i class="fas fa-check-circle" style="color:#28a745;"></i> Firebase conectado y sincronizando.';
    } else {
      statusEl.innerHTML = '<i class="fas fa-info-circle" style="color:#F57C00;"></i> Credenciales guardadas. Recarga la app para conectar.';
    }
  }
}

async function migrarAFirebase() {
  if (!db) {
    return alert("Firebase no está configurado. Primero ingresa los datos de conexión arriba.");
  }
  if (!confirm("¿Subir todos los datos locales a Firebase? Los datos existentes en la nube no se borrarán.")) return;

  const btn = document.getElementById('btn-migrar');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Subiendo…'; }

  try {
    const batch_distrib = db.batch();
    for (let d of distribuidores) {
      batch_distrib.set(db.collection("distribuidores").doc(d.id.toString()), d);
    }
    await batch_distrib.commit();

    for (let v of vendedores) {
      await db.collection("vendedores").doc(v.id.toString()).set(v);
    }
    await db.collection("marcas").doc("globales").set({ lista: marcas });

    // Visitas en lotes de 400 para evitar límite de Firestore (500/batch)
    for (let i = 0; i < visitas.length; i += 400) {
      const lote = db.batch();
      visitas.slice(i, i + 400).forEach(v => {
        lote.set(db.collection("visitas").doc(v.id.toString()), v);
      });
      await lote.commit();
    }

    for (let n of notasGlobales) {
      await db.collection("notas").doc(n.id.toString()).set(n);
    }

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Migración completada'; }
    showToast('✅ Datos subidos a Firebase correctamente');
  } catch (error) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Reintentar migración'; }
    alert("❌ Error en la migración: " + error.message);
  }
}

// ==========================================
// 5. NAVEGACIÓN Y UTILIDADES
// ==========================================
function switchTab(tabId, title, btnElement) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  }); 
  document.getElementById(tabId).classList.add('active');
  
  if (btnElement) {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.remove('active');
    }); 
    btnElement.classList.add('active'); 
  }
  
  if (title) {
    document.getElementById('header-title').innerText = title;
  }
  
  const btnFlotante = document.getElementById('fab-voice');
  if (btnFlotante) {
    btnFlotante.style.display = (tabId === 'view-voice' || tabId.includes('view-form')) ? 'none' : 'flex';
  }
  
  if (tabId === 'view-calendar') {
    mostrarRegistrosPorFecha();
  }
  if (tabId === 'view-stats') {
    actualizarEstadisticas();
  }
  if (tabId === 'view-directorio') { 
    cambiarVistaDir('vendedores'); 
    renderizarDirectorio(); 
  }
  if (tabId === 'view-distrib') {
    inicializarHubDistrib();
  }
  if (tabId === 'view-voice') { 
    document.getElementById("panel-nota-nueva").style.display = "none"; 
    document.getElementById("box-respuesta-asistente").style.display = "none"; 
    renderizarNotasGlobales(); 
  }
  if (tabId === 'view-settings') { 
    document.getElementById('gcal-id').value = googleCalendarId; 
    document.getElementById('gemini-key').value = geminiApiKey;
    cargarConfigFirebaseEnFormulario();
    // Sincronizar estado del toggle de modo oscuro
    const temaActual = document.documentElement.getAttribute('data-theme') || 'light';
    aplicarTema(temaActual);
  }
  if (tabId === 'view-audit') {
    actualizarDependenciasAudit();
  }
}

function showToast(mensaje) {
  const container = document.getElementById("toast-container"); 
  const toast = document.createElement("div"); 
  toast.className = "toast";
  toast.innerHTML = `<i class="fas fa-check-circle" style="color:#28a745; margin-right:8px;"></i> ${mensaje}`; 
  container.appendChild(toast); 
  
  setTimeout(() => {
    toast.remove();
  }, 3000);
}


// ==========================================
// MODO OSCURO
// ==========================================
function toggleDarkMode() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const newTheme = isDark ? 'light' : 'dark';
  aplicarTema(newTheme);
  localStorage.setItem('tema', newTheme);
}

function aplicarTema(tema) {
  document.documentElement.setAttribute('data-theme', tema);
  const checkbox = document.getElementById('dark-mode-toggle');
  const slider   = document.getElementById('dark-mode-slider');
  const knob     = document.getElementById('dark-mode-knob');
  const icon     = document.getElementById('dark-mode-icon');
  const isDark   = tema === 'dark';

  if (checkbox) checkbox.checked = isDark;
  if (slider)   slider.style.background = isDark ? '#4d9fff' : '#ccc';
  if (knob)     knob.style.transform = isDark ? 'translateX(24px)' : 'translateX(0)';
  if (icon)     icon.textContent = isDark ? '☀️' : '🌙';
}

// ==========================================
// FORM STATE PERSISTENCE (Fix bug pérdida de datos)
// ==========================================
function saveFormState() {
  try {
    const state = {
      distribuidor: document.getElementById('distribuidor')?.value || '',
      vendedor: document.getElementById('vendedor')?.value || '',
      zona: document.getElementById('zona')?.value || '',
      tienda: document.getElementById('tienda')?.value || '',
      notas: document.getElementById('notas-visita')?.value || '',
      comentarioGeneral: document.getElementById('comentario-general-auditoria')?.value || '',
      comproPorGenomma: document.getElementById('compro-genomma')?.checked || false,
      comproPorDuracell: document.getElementById('compro-duracell')?.checked || false,
      marcasCheck: {},
      visitaCheck: {},
      popCheck: {}
    };
    document.querySelectorAll('#marcas-senso input[type="checkbox"]').forEach(cb => {
      state.marcasCheck[cb.dataset.marca] = cb.checked;
    });
    aspectosVisita.forEach((_, i) => {
      const el = document.getElementById(`visita-${i}`);
      if (el) state.visitaCheck[i] = el.checked;
    });
    materialesPOP.forEach((_, i) => {
      const el = document.getElementById(`pop-${i}`);
      if (el) state.popCheck[i] = el.checked;
    });
    localStorage.setItem('formState', JSON.stringify(state));
  } catch(e) {}
}

function restoreFormState() {
  try {
    const stateStr = localStorage.getItem('formState');
    if (!stateStr) return;
    const state = JSON.parse(stateStr);

    // Restaurar distribuidor y forzar rebuild de vendedores
    const selDistri = document.getElementById('distribuidor');
    if (selDistri && state.distribuidor) {
      const opt = [...selDistri.options].find(o => o.value === state.distribuidor);
      if (opt) {
        selDistri.value = state.distribuidor;
        // Reconstruir vendedores con el distribuidor correcto
        // y aplicar vendedor guardado dentro de esa llamada
        window._pendingVendedorRestore = state.vendedor || '';
        actualizarDependenciasAudit();
      }
    }

    // Campos de texto
    if (state.zona    && document.getElementById('zona'))          document.getElementById('zona').value          = state.zona;
    if (state.tienda  && document.getElementById('tienda'))        document.getElementById('tienda').value        = state.tienda;
    if (state.notas   && document.getElementById('notas-visita'))  document.getElementById('notas-visita').value  = state.notas;
    if (state.comentarioGeneral && document.getElementById('comentario-general-auditoria')) document.getElementById('comentario-general-auditoria').value = state.comentarioGeneral;
    if (state.comproPorGenomma  && document.getElementById('compro-genomma'))  document.getElementById('compro-genomma').checked  = state.comproPorGenomma;
    if (state.comproPorDuracell && document.getElementById('compro-duracell')) document.getElementById('compro-duracell').checked = state.comproPorDuracell;

    // Checkboxes de marcas, visita y pop — se aplican en actualizarDependenciasAudit (pendientes)
    window._pendingMarcasRestore = state.marcasCheck  || {};
    window._pendingVisitaRestore = state.visitaCheck  || {};
    window._pendingPopRestore    = state.popCheck     || {};

  } catch(e) { console.warn('restoreFormState error:', e); }
}

// ==========================================
// INICIO DE DÍA
// ==========================================
function verificarInicioDia() {
  // Poblar checkboxes de agotados con las marcas del distribuidor seleccionado
  const distriSeleccionado = document.getElementById("distribuidor")?.value || "";
  const distriObj = distribuidores.find(d => d.nombre === distriSeleccionado);
  const marcasContexto = (distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.length > 0)
    ? distriObj.marcasAsignadas
    : marcas.map(m => typeof m === 'object' ? m.nombre : m);

  const contenedorAgotados = document.getElementById('dia-agotados-container');
  if (contenedorAgotados) {
    let htmlAgotados = '';
    marcasContexto.forEach(nombre => {
      // Si ya hay dato del día, pre-marcar los que estaban agotados
      const yaAgotado = datoDiario && datoDiario.agotados && datoDiario.agotados.includes(nombre);
      htmlAgotados += `<div class="cuali-item"><span>${nombre}</span><input type="checkbox" id="agotado-${nombre.replace(/\s/g,'_')}" ${yaAgotado ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--primary);"></div>`;
    });
    contenedorAgotados.innerHTML = htmlAgotados;
  }
  
  const modal = document.getElementById('modal-inicio-dia');
  if (modal) { modal.style.display = 'flex'; }
}

function guardarDatoDiario() {
  const codigo = document.getElementById('dia-codigo-ruta')?.value.trim();
  const numClientes = document.getElementById('dia-num-clientes')?.value.trim();
  
  if (!codigo || !numClientes) return alert('Por favor completa el Código de Ruta y el Número de Clientes.');
  
  const distriSeleccionado = document.getElementById("distribuidor")?.value || "";
  const distriObj = distribuidores.find(d => d.nombre === distriSeleccionado);
  const marcasContexto = (distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.length > 0)
    ? distriObj.marcasAsignadas
    : marcas.map(m => typeof m === 'object' ? m.nombre : m);

  const agotados = [];
  marcasContexto.forEach(nombre => {
    const cb = document.getElementById(`agotado-${nombre.replace(/\s/g,'_')}`);
    if (cb && cb.checked) agotados.push(nombre);
  });
  
  datoDiario = { codigo, numClientes, agotados, fecha: getHoy(), distribuidor: distriSeleccionado };
  localStorage.setItem('datoDiario_' + getHoy(), JSON.stringify(datoDiario));
  
  const modal = document.getElementById('modal-inicio-dia');
  if (modal) modal.style.display = 'none';
  
  // Mostrar resumen en el botón de inicio de ruta
  actualizarBtnInicioRuta();
  showToast('¡Datos de ruta guardados!');
}

// ==========================================
// INFORME OPERATIVO
// ==========================================
function actualizarBtnInicioRuta() {
  const btn = document.getElementById('btn-inicio-ruta');
  if (!btn) return;
  if (datoDiario) {
    const agotadosTxt = datoDiario.agotados && datoDiario.agotados.length > 0
      ? `🚫 Agotados: ${datoDiario.agotados.join(', ')}`
      : '✅ Sin agotados';
    btn.innerHTML = `<i class="fas fa-route" style="color:#28a745;"></i> Ruta: <b>${datoDiario.codigo}</b> · ${datoDiario.numClientes} clientes · <span style="font-size:0.75rem;">${agotadosTxt}</span> <i class="fas fa-pencil-alt" style="margin-left:5px; opacity:0.6; font-size:0.75rem;"></i>`;
    btn.style.background = '#e8f5e9';
    btn.style.color = '#155724';
    btn.style.border = '1px solid #c3e6cb';
  } else {
    btn.innerHTML = `<i class="fas fa-play-circle" style="color:var(--primary);"></i> <b>Iniciar Ruta del Día</b> <small style="opacity:0.7;">(código, clientes, agotados)</small>`;
    btn.style.background = '#e8f0fe';
    btn.style.color = '#1a237e';
    btn.style.border = '1px solid #b6d4fe';
  }
}

function generarInformeOperativo() {
  const datos = obtenerDatosFiltrados().principal;
  if (datos.length === 0) return alert("Sin datos para el periodo seleccionado.");
  
  const grupos = {};
  datos.forEach(v => {
    const clave = `${v.distribuidor}|${v.vendedor}`;
    if (!grupos[clave]) grupos[clave] = [];
    grupos[clave].push(v);
  });
  
  let informes = [];
  Object.keys(grupos).forEach(clave => {
    const grupo = grupos[clave];
    const datos0 = grupo[0];
    const claveEdit = `${datos0.fechaISO}|${datos0.distribuidor}|${datos0.vendedor}`;
    const editData = datosHistorialEdit[claveEdit] || {};
    
    const impactosGenomma = editData.impactosGenomma !== undefined ? editData.impactosGenomma : grupo.filter(v => v.comproPorGenomma).length;
    const valorGenomma = editData.valorGenomma !== undefined ? editData.valorGenomma : 0;
    
    const distriObj = distribuidores.find(d => d.nombre === datos0.distribuidor);
    const vendeDuracell = distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.includes('Duracell');
    
    const impactosDuracell = vendeDuracell ? (editData.impactosDuracell !== undefined ? editData.impactosDuracell : grupo.filter(v => v.comproPorDuracell).length) : 0;
    const valorDuracell = vendeDuracell ? (editData.valorDuracell !== undefined ? editData.valorDuracell : 0) : 0;
    
    const totalImpactos = impactosGenomma + impactosDuracell;
    const totalValor = parseFloat(valorGenomma || 0) + parseFloat(valorDuracell || 0);
    
    const numVisitas = datoDiario ? datoDiario.numClientes : grupo.length;
    
    let texto = `Buenas tardes\n\nAcompañamiento\n${datos0.distribuidor}\nVendedor: ${datos0.vendedor}\nVisitas: ${numVisitas}\n*Genomma*\nImpactos: ${impactosGenomma}\nValor total: $${Number(valorGenomma||0).toLocaleString('es-CO')}\n*Duracell*\nImpactos: ${impactosDuracell}\nValor: $${Number(valorDuracell||0).toLocaleString('es-CO')}\n*Total*\nImpactos: ${totalImpactos}\nValor: $${totalValor.toLocaleString('es-CO')}`;
    
    informes.push(texto);
  });
  
  const box = document.getElementById('box-informe-operativo');
  if (box) {
    box.style.display = 'block';
    box.innerHTML = informes.map((inf, i) => `
      <div style="background:white; border-radius:8px; padding:12px; margin-bottom:10px; border-left:4px solid var(--success); font-family:monospace; white-space:pre-line; font-size:0.85rem;">${inf.replace(/\*(.*?)\*/g,'<b>$1</b>')}
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button onclick="copiarInformeOp(${i})" class="btn-primary" style="flex:1; padding:8px; font-size:0.85rem; background:#25D366;"><i class="fab fa-whatsapp"></i> Copiar/WA</button>
      </div>
      </div>`).join('');
    window._informesOpText = informes;
  }
  document.getElementById('box-reporte-gerencia').style.display = 'none';
  
  // Auto-guardar informe operativo
  informes.forEach((texto, i) => {
    const nuevoInforme = {
      id: Date.now() + i,
      tipo: 'operativo',
      fecha: getHoy(),
      horaGuardado: new Date().toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'}),
      texto: texto.replace(/\*(.*?)\*/g,'<b>$1</b>'),
      textoPlano: texto
    };
    informesGuardados.push(nuevoInforme);
  });
  localStorage.setItem('informesGuardados', JSON.stringify(informesGuardados));
  showToast('Informe operativo guardado');
}

function copiarInformeOp(index) {
  if (!window._informesOpText) return;
  const texto = window._informesOpText[index];
  navigator.clipboard.writeText(texto).then(() => showToast('¡Copiado al portapapeles!')).catch(() => {
    const wa = `https://wa.me/?text=${encodeURIComponent(texto)}`;
    window.open(wa, '_blank');
  });
}

function buscarInformesPorFecha() {
  const fecha = document.getElementById('filtro-informes-fecha')?.value;
  if (!fecha) return;
  const container = document.getElementById('lista-informes-guardados');
  if (!container) return;
  
  const encontrados = informesGuardados.filter(inf => inf.fecha === fecha);
  if (encontrados.length === 0) {
    container.innerHTML = '<p style="color:#888; text-align:center;">No hay informes guardados en esta fecha.</p>';
    return;
  }
  
  const colores = { supervisor: '#673AB7', operativo: '#28a745', ia: '#0066cc' };
  const labels = { supervisor: 'Supervisor', operativo: 'Operativo', ia: 'IA' };
  
  container.innerHTML = encontrados.reverse().map((inf) => {
    const tipo = inf.tipo || 'ia';
    const color = colores[tipo] || '#673AB7';
    const label = labels[tipo] || tipo;
    const waText = encodeURIComponent(inf.textoPlano || inf.texto.replace(/<[^>]*>/g,''));
    return `
    <div style="background:white; border-radius:8px; padding:10px; margin-bottom:8px; border-left:4px solid ${color};">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
        <span style="font-size:0.7rem; font-weight:bold; background:${color}; color:white; padding:2px 8px; border-radius:10px;">${label}</span>
        <span style="font-size:0.75rem; color:#666;"><i class="fas fa-clock"></i> ${inf.horaGuardado}</span>
      </div>
      <div style="cursor:pointer;" onclick="toggleDirElement('inf-body-${inf.id}','inf-icon-${inf.id}')">
        <span style="font-size:0.85rem; color:#333; font-weight:bold;">Ver contenido <i class="fas fa-chevron-down" id="inf-icon-${inf.id}"></i></span>
      </div>
      <div id="inf-body-${inf.id}" style="display:none; margin-top:8px; font-size:0.82rem; color:#444;">${inf.texto}</div>
      <button class="btn-primary" style="margin-top:8px; padding:6px 12px; width:auto; font-size:0.8rem; background:#25D366;" onclick="window.open('https://wa.me/?text=${waText}','_blank')">
        <i class="fab fa-whatsapp"></i> Enviar WA
      </button>
      <button class="btn-primary" style="margin-top:8px; padding:6px 12px; width:auto; font-size:0.8rem; background:#dc3545; margin-left:5px;" onclick="eliminarInforme(${inf.id})">
        <i class="fas fa-trash"></i>
      </button>
    </div>`;
  }).join('');
}

function eliminarInforme(id) {
  if (!confirm('¿Eliminar este informe?')) return;
  informesGuardados = informesGuardados.filter(i => i.id !== id);
  localStorage.setItem('informesGuardados', JSON.stringify(informesGuardados));
  buscarInformesPorFecha();
  showToast('Informe eliminado');
}

function toggleDirElement(bodyId, iconId) {
  const body = document.getElementById(bodyId);
  const icon = document.getElementById(iconId);
  
  if (!body || !icon) return;
  
  if (body.style.display === 'none' || body.style.display === '') {
    body.style.display = 'block';
    icon.classList.remove('fa-chevron-down');
    icon.classList.add('fa-chevron-up');
  } else {
    body.style.display = 'none';
    icon.classList.remove('fa-chevron-up');
    icon.classList.add('fa-chevron-down');
  }
}

// ==========================================
// 6. FOTOS Y COMPRESIÓN
// ==========================================
function procesarFoto(event) {
  const file = event.target.files[0]; 
  if (!file) return; 
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image(); 
    img.onload = function() {
      fotoBase64AI = comprimirImagen(img, 900, 0.80);   // Alta calidad para análisis IA 
      fotoMinBase64 = comprimirImagen(img, 150, 0.5); 
      
      document.getElementById("foto-preview").src = fotoBase64AI; 
      document.getElementById("foto-preview-container").style.display = "block";
      document.getElementById("btn-ia-foto").style.display = "block"; 
      document.getElementById("box-ia-foto").style.display = "none";
      
      // Auto-analizar si hay API key configurada
      if (geminiApiKey) {
        analizarFotoIA();
      }
    }; 
    img.src = e.target.result;
  }; 
  reader.readAsDataURL(file);
}

function comprimirImagen(img, maxWidth, quality) {
  const canvas = document.createElement("canvas"); 
  let width = img.width; 
  let height = img.height;
  
  if (width > maxWidth) { 
    height = Math.round((height * maxWidth) / width); 
    width = maxWidth; 
  }
  
  canvas.width = width; 
  canvas.height = height; 
  const ctx = canvas.getContext("2d"); 
  ctx.drawImage(img, 0, 0, width, height); 
  
  return canvas.toDataURL("image/jpeg", quality);
}

// ==========================================
// 7. DICTADO POR VOZ
// ==========================================
function iniciarDictado(inputId, btnId) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) { 
    alert("Tu navegador no soporta dictado por voz. Usa Chrome."); 
    return; 
  }
  
  const btn = document.getElementById(btnId); 
  const area = document.getElementById(inputId); 
  const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
  
  recognition.lang = 'es-ES'; 
  recognition.interimResults = false;
  
  recognition.onstart = function() { 
    btn.classList.add("pulsing"); 
  };
  
  recognition.onresult = function(event) { 
    area.value += (area.value ? " " : "") + event.results[0][0].transcript + ". "; 
  };
  
  recognition.onerror = function() { 
    btn.classList.remove("pulsing"); 
  }; 
  
  recognition.onend = function() { 
    btn.classList.remove("pulsing"); 
  }; 
  
  recognition.start();
}

function toggleGrabacionCentral() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) { 
    alert("Navegador no soporta dictado."); 
    return; 
  }
  
  const btn = document.getElementById("btn-grabar-central"); 
  const status = document.getElementById("status-grabacion"); 
  const area = document.getElementById("texto-nota-central");
  
  if (isRecordingGlobal) {
    // Parar grabación
    if(voiceRecognition) voiceRecognition.stop();
    btn.classList.remove("pulsing"); 
    btn.innerHTML = '<i class="fas fa-microphone"></i>'; 
    status.style.display = "none"; 
    isRecordingGlobal = false;
    document.getElementById("panel-nota-nueva").style.display = "block"; 
    document.getElementById("box-respuesta-asistente").style.display = "none";
  } else {
    // Iniciar grabación
    isRecordingGlobal = true; 
    area.value = ""; 
    document.getElementById("msg-ia-nota").style.display = "none"; 
    document.getElementById("box-respuesta-asistente").style.display = "none";
    btn.classList.add("pulsing"); 
    btn.innerHTML = '<i class="fas fa-stop"></i>'; 
    status.style.display = "block"; 
    document.getElementById("panel-nota-nueva").style.display = "none";
    
    voiceRecognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    voiceRecognition.lang = 'es-ES'; 
    voiceRecognition.interimResults = false;
    
    voiceRecognition.onresult = function(event) { 
      area.value += (area.value ? " " : "") + event.results[0][0].transcript + ". "; 
    };
    
    voiceRecognition.onerror = function() { 
      btn.classList.remove("pulsing"); 
      btn.innerHTML = '<i class="fas fa-microphone"></i>'; 
      status.style.display = "none"; 
      isRecordingGlobal = false; 
    };
    
    voiceRecognition.onend = function() { 
      btn.classList.remove("pulsing"); 
      btn.innerHTML = '<i class="fas fa-microphone"></i>'; 
      status.style.display = "none"; 
      isRecordingGlobal = false; 
      if (area.value.trim() !== "") {
        document.getElementById("panel-nota-nueva").style.display = "block";
      }
    };
    
    voiceRecognition.start();
  }
}

// ==========================================
// 8. ASISTENTE VIRTUAL RAG Y CALENDARIO
// ==========================================
function formatearBaseDatosIA() {
  const hoy = getHoy();
  const mesActual = hoy.substring(0, 7);

  // ── DISTRIBUIDORES ────────────────────────────────────────────
  const resDistrib = distribuidores.map(d => ({
    nombre: d.nombre,
    ciudad: d.ciudad || 'N/D',
    clientes: d.clientes || 0,
    marcas: d.marcasAsignadas || [],
    supervisores: (d.supervisores || []).map(s => s.nombre),
    vendeDuracell: (d.marcasAsignadas || []).includes('Duracell')
  }));

  // ── VENDEDORES ────────────────────────────────────────────────
  const resVend = vendedores.map(v => ({
    nombre: v.nombre,
    distribuidor: v.distribuidor,
    telefono: v.telefono || 'N/D'
  }));

  // ── VISITAS: resumen estadístico completo ─────────────────────
  const visitasHoy    = visitas.filter(v => v.fechaISO === hoy);
  const visitasMes    = visitas.filter(v => v.fechaISO.startsWith(mesActual));
  const todasFechas   = [...new Set(visitas.map(v => v.fechaISO))].sort().reverse();
  const ultimasFechas = todasFechas.slice(0, 30); // últimas 30 jornadas

  // Stats por distribuidor
  const statsPorDistrib = {};
  visitas.forEach(v => {
    if (!statsPorDistrib[v.distribuidor]) {
      statsPorDistrib[v.distribuidor] = { acomp: 0, tiendas: 0, impG: 0, impD: 0 };
    }
    statsPorDistrib[v.distribuidor].tiendas++;
    if (v.comproPorGenomma) statsPorDistrib[v.distribuidor].impG++;
    if (v.comproPorDuracell) statsPorDistrib[v.distribuidor].impD++;
  });
  // Contar acompañamientos únicos (fecha+vendedor)
  const accompUnicos = {};
  visitas.forEach(v => {
    const k = `${v.distribuidor}|${v.fechaISO}|${v.vendedor}`;
    if (!accompUnicos[k]) { accompUnicos[k] = true; if (!statsPorDistrib[v.distribuidor]) statsPorDistrib[v.distribuidor] = {}; statsPorDistrib[v.distribuidor].acomp = (statsPorDistrib[v.distribuidor].acomp || 0) + 1; }
  });

  // Stats por vendedor (mes actual)
  const statsPorVend = {};
  visitasMes.forEach(v => {
    if (!statsPorVend[v.vendedor]) statsPorVend[v.vendedor] = { tiendas: 0, impG: 0, marcasPct: [] };
    statsPorVend[v.vendedor].tiendas++;
    if (v.comproPorGenomma) statsPorVend[v.vendedor].impG++;
    if (v.resultados) {
      const pct = v.resultados.length ? Math.round(v.resultados.filter(r => r.disponible).length / v.resultados.length * 100) : 0;
      statsPorVend[v.vendedor].marcasPct.push(pct);
    }
  });
  Object.keys(statsPorVend).forEach(vend => {
    const arr = statsPorVend[vend].marcasPct;
    statsPorVend[vend].marcasProm = arr.length ? Math.round(arr.reduce((a,b)=>a+b,0)/arr.length) : 0;
    delete statsPorVend[vend].marcasPct;
  });

  // Presencia de marcas global (mes)
  const marcaStats = {};
  visitasMes.forEach(v => {
    if (v.resultados) v.resultados.forEach(r => {
      if (!marcaStats[r.marca]) marcaStats[r.marca] = { t: 0, c: 0 };
      marcaStats[r.marca].t++;
      if (r.disponible) marcaStats[r.marca].c++;
    });
  });
  const presenciaMarcas = Object.keys(marcaStats).map(m => ({
    marca: m, pct: Math.round((marcaStats[m].c / marcaStats[m].t) * 100)
  })).sort((a,b) => a.pct - b.pct);

  // Novedades de campo (notas de visitas) - últimas 20
  const novedades = visitas
    .filter(v => v.notas && v.notas.trim().length > 3)
    .sort((a,b) => b.fechaISO.localeCompare(a.fechaISO))
    .slice(0, 20)
    .map(v => ({ fecha: v.fechaISO, vendedor: v.vendedor, tienda: v.tienda, novedad: v.notas }));

  // Comentarios generales de auditoría - últimos 15
  const comentariosGeneralesWiki = visitas
    .filter(v => v.comentarioGeneral && v.comentarioGeneral.trim().length > 3)
    .sort((a,b) => b.fechaISO.localeCompare(a.fechaISO))
    .slice(0, 15)
    .map(v => ({ fecha: v.fechaISO, vendedor: v.vendedor, distribuidor: v.distribuidor, comentario: v.comentarioGeneral }));

  // Análisis visual IA acumulado - últimos 10
  const analysisIA = visitas
    .filter(v => v.analisisVisual && v.analisisVisual.length > 20)
    .sort((a,b) => b.fechaISO.localeCompare(a.fechaISO))
    .slice(0, 10)
    .map(v => ({ fecha: v.fechaISO, tienda: v.tienda, analisis: v.analisisVisual.replace(/<[^>]*>/g,'').substring(0, 200) }));

  // ── TAREAS ────────────────────────────────────────────────────
  const tareasPendientes = [];
  const tareasCompletas  = [];
  Object.keys(tareasDistrib).forEach(distrib => {
    (tareasDistrib[distrib] || []).forEach(t => {
      const obj = { distribuidor: distrib, descripcion: t.descripcion, categoria: t.categoria, fecha: t.fecha };
      if (t.hecha) tareasCompletas.push({ ...obj, completada: t.fechaCompletada });
      else tareasPendientes.push(obj);
    });
  });
  tareasPendientes.sort((a,b) => (a.fecha||'') > (b.fecha||'') ? 1 : -1);

  // ── NOTAS GLOBALES (asistente) ────────────────────────────────
  const notasRes = notasGlobales
    .sort((a,b) => b.id - a.id)
    .slice(0, 20)
    .map(n => ({ fecha: n.fechaCreacion, titulo: n.titulo, contenido: n.textoOriginal?.substring(0,200) }));

  // ── INFORMES GUARDADOS (resumen) ──────────────────────────────
  const informesRes = informesGuardados
    .sort((a,b) => b.id - a.id)
    .slice(0, 5)
    .map(i => ({ fecha: i.fecha, tipo: i.tipo, hora: i.horaGuardado }));

  // ── DATOS DE INICIO DE DÍA ────────────────────────────────────
  const infoDia = datoDiario || {};

  return JSON.stringify({
    fecha_hoy: hoy,
    datos_dia_actual: {
      codigo_ruta: infoDia.codigo || 'No registrado',
      clientes_ruta: infoDia.numClientes || 0,
      agotados: infoDia.agotados || [],
      tiendas_auditadas_hoy: visitasHoy.length,
      impactos_genomma_hoy: visitasHoy.filter(v=>v.comproPorGenomma).length,
      impactos_duracell_hoy: visitasHoy.filter(v=>v.comproPorDuracell).length
    },
    resumen_mes: {
      total_tiendas: visitasMes.length,
      total_jornadas: [...new Set(visitasMes.map(v => v.fechaISO))].length,
      impactos_genomma: visitasMes.filter(v=>v.comproPorGenomma).length,
      impactos_duracell: visitasMes.filter(v=>v.comproPorDuracell).length
    },
    distribuidores: resDistrib,
    vendedores: resVend,
    estadisticas_por_distribuidor: statsPorDistrib,
    estadisticas_por_vendedor_mes: statsPorVend,
    presencia_marcas_mes: presenciaMarcas,
    jornadas_registradas: ultimasFechas,
    novedades_campo: novedades,
    comentarios_generales_auditoria: comentariosGeneralesWiki,
    analisis_visual_ia: analysisIA,
    tareas_pendientes: tareasPendientes,
    tareas_completadas: tareasCompletas.slice(-10),
    notas_guardadas: notasRes,
    informes_recientes: informesRes,
    marcas_portafolio: marcas.map(m => typeof m === 'object' ? m.nombre : m)
  }, null, 0); // null, 0 = sin espacios para minimizar tokens
}

function generarEnlaceCalendario(titulo, detalle, fecha, horaInicio, horaFin) {
  if (!fecha) return "";

  const fStr = fecha.replace(/-/g, '');

  // Convertir hora "HH:MM" → "HHMMSS" para la URL de Google Calendar
  const toGCalHora = (h) => (h || '09:00').replace(/:/g, '') + '00';

  const hIni = toGCalHora(horaInicio);
  // Si hay hora de fin, usar esa; si no, sumar 1 hora al inicio como duración mínima
  let hFin;
  if (horaFin) {
    hFin = toGCalHora(horaFin);
  } else {
    // Sumar 1 hora al inicio
    const [h, m] = (horaInicio || '09:00').split(':').map(Number);
    const finH = String((h + 1) % 24).padStart(2, '0');
    hFin = `${finH}${String(m).padStart(2, '0')}00`;
  }

  const tituloCodificado  = encodeURIComponent(titulo);
  const detalleCodificado = encodeURIComponent(detalle);

  // color=9 → Grape (morado) en Google Calendar
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${tituloCodificado}&dates=${fStr}T${hIni}/${fStr}T${hFin}&details=${detalleCodificado}&color=9`;
}

async function enviarAlAsistenteIA() {
  const textoOriginal = document.getElementById("texto-nota-central").value.trim();
  const urgente       = document.getElementById("urgente-nota").checked;
  const fechaManual   = document.getElementById("fecha-recordatorio").value;
  const horaManual    = document.getElementById("hora-recordatorio").value;

  const btn     = document.getElementById("btn-procesar-nota-ia");
  const msg     = document.getElementById("msg-ia-nota");
  const boxResp = document.getElementById("box-respuesta-asistente");

  if (!textoOriginal) return alert("La caja de texto está vacía. Escribe o dicta algo.");

  if (!geminiApiKey) {
    const tituloAuto = textoOriginal.split(' ').slice(0, 5).join(' ');
    const recVacio = fechaManual ? `${fechaManual} ${horaManual || '09:00'}` : null;
    return guardarNotaFisica(tituloAuto, textoOriginal, textoOriginal, urgente, recVacio);
  }

  btn.disabled = true;
  msg.style.display = "block";
  msg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Consultando la base de datos…';
  boxResp.style.display = "none";

  const d = new Date();
  const fechaHoyTexto = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const diaSemana = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'][d.getDay()];

  // Detección anticipada de intención
  const textoLower = textoOriginal.toLowerCase();
  const palabrasCalendario = ['calendario','agendar','agenda','programar','reunión','reunion','cita','recordar','recordatorio','evento','mañana','próxima semana','proxima semana','el lunes','el martes','el miércoles','el jueves','el viernes'];
  const palabrasConsulta   = ['cuánto','cuanto','cuál','cual','quién','quien','dónde','donde','cómo','como','cuántas','cuantas','qué','que','dime','dame','muéstrame','muestrame','cuéntame','cuentame','infórmame','informame','resumen','reporte','estadística','estadistica','cómo va','como va','cómo están','como estan'];
  const quiereAgendar   = palabrasCalendario.some(p => textoLower.includes(p));
  const esConsulta      = palabrasConsulta.some(p => textoLower.includes(p)) || textoOriginal.includes('?');

  const refuerzoCalendario = quiereAgendar && !esConsulta
    ? `\nATENCIÓN: El usuario menciona palabras de calendario/agenda. Prioriza "accion":"agendar".`
    : '';
  const refuerzoWiki = esConsulta || (!quiereAgendar)
    ? `\nATENCIÓN: El usuario está haciendo una consulta. Responde con "accion":"consulta" usando todos los datos disponibles.`
    : '';

  // Construir contexto completo (wiki)
  let contextoWiki = '';
  try {
    contextoWiki = formatearBaseDatosIA();
    // Limitar a 4000 chars para no exceder tokens
    if (contextoWiki.length > 4000) contextoWiki = contextoWiki.substring(0, 4000) + '...}';
  } catch(e) { contextoWiki = '{}'; }

  const prompt = `Eres WIKI-IA, el asistente inteligente de Cesar Pescador, Gestor Sell Out Genomma Lab.
Tienes acceso completo a TODA la base de datos de la aplicación de auditoría.
FECHA HOY: ${fechaHoyTexto} (${diaSemana}).

BASE DE DATOS COMPLETA:
${contextoWiki}

PREGUNTA/MENSAJE DEL USUARIO: "${truncar(textoOriginal, 900)}"
${refuerzoCalendario}${refuerzoWiki}

INSTRUCCIONES DE RESPUESTA:
IMPORTANTE: Sé siempre ESPECÍFICO y COMPLETO. Cita datos exactos (números, nombres, fechas, porcentajes). NUNCA respondas con generalidades o evasivas. Si la información está en la BD, dala completa.

Acción "consulta" → cuando el usuario pregunta sobre datos, estadísticas, vendedores, tiendas, marcas, tareas, novedades, etc.
  - "respuesta": texto claro y completo respondiendo la pregunta con los datos exactos de la BD
  - "acciones_sugeridas": array con 3-4 acciones concretas que el usuario puede hacer con esa información (ej: "Enviar reporte por WhatsApp", "Agendar seguimiento con el vendedor", "Crear tarea de refuerzo", "Generar informe al supervisor")
  - "titulo": resumen en 4 palabras de la consulta

Acción "agendar" → cuando quiere programar un evento/recordatorio en calendario
  - "fecha_agendada": YYYY-MM-DD
  - "hora_agendada": HH:MM
  - "titulo": nombre del evento
  - "resumen": descripción

Acción "nota" → para todo lo demás (observaciones, novedades, hallazgos de campo)
  - "titulo": OBLIGATORIO, 4-6 palabras descriptivas
  - "resumen": texto organizado

RESPONDE SOLO JSON sin texto extra:
{"accion":"","respuesta":"","titulo":"","resumen":"","fecha_agendada":"","hora_agendada":"","acciones_sugeridas":[]}`;

  try {
    const textoIA = await llamarGemini({ prompt, maxRetries: 2, maxTokens: 2000 });

    // Extracción robusta del JSON (la IA a veces añade backticks)
    const jsonMatch = textoIA.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("La IA no devolvió JSON reconocible.");

    const iaResult = JSON.parse(jsonMatch[0]);

    // ── CONSULTA WIKI ──────────────────────────────────────────
    if (iaResult.accion === "consulta" || (iaResult.accion === "pregunta" && iaResult.respuesta)) {
      const acciones = iaResult.acciones_sugeridas || [];
      const botonesAcciones = acciones.map((accion, i) => {
        const iconos = ['fa-paper-plane','fa-calendar-plus','fa-tasks','fa-file-alt','fa-whatsapp','fa-chart-bar'];
        const colores = ['#673AB7','#4285F4','#28a745','#e67e22','#25D366','#17a2b8'];
        return `<button onclick="ejecutarAccionWiki(${i}, '${iaResult.titulo || ''}')"
          style="background:${colores[i%colores.length]}; color:white; border:none; padding:8px 12px;
          border-radius:8px; font-size:0.82rem; cursor:pointer; text-align:left; display:flex; align-items:center; gap:6px;">
          <i class="fas ${iconos[i%iconos.length]}"></i> ${accion}
        </button>`;
      }).join('');

      // Guardar contexto de acciones para uso posterior
      window._wikiUltimasAcciones = acciones;
      window._wikiUltimaRespuesta = iaResult.respuesta;
      window._wikiUltimoTitulo    = iaResult.titulo;

      const tituloNota = (iaResult.titulo?.trim().length > 2) ? iaResult.titulo : textoOriginal.split(' ').slice(0,5).join(' ');
      guardarNotaFisica(tituloNota, textoOriginal, textoAHtml(iaResult.respuesta || textoOriginal), urgente, null);

      boxResp.innerHTML = `
        <div style="background:#f3e5f5; border-radius:10px; padding:14px; margin-bottom:0;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; border-bottom:1px solid #ce93d8; padding-bottom:8px;">
            <i class="fas fa-robot" style="color:#673AB7; font-size:1.1rem;"></i>
            <b style="color:#673AB7;">Wiki Genomma Lab</b>
          </div>
          <div style="font-size:0.9rem; color:#333; line-height:1.6; margin-bottom:14px;">
            ${(iaResult.respuesta || '').replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<b>$1</b>')}
          </div>
          ${acciones.length > 0 ? `
          <div style="border-top:1px solid #ce93d8; padding-top:12px;">
            <p style="font-size:0.78rem; color:#673AB7; font-weight:bold; margin-bottom:8px;">
              <i class="fas fa-lightbulb"></i> ¿Qué quieres hacer con esta información?
            </p>
            <div style="display:flex; flex-direction:column; gap:6px;">
              ${botonesAcciones}
            </div>
          </div>` : ''}
        </div>`;
      boxResp.style.display = "block";

    // ── AGENDAR ────────────────────────────────────────────────
    } else if (iaResult.accion === "agendar") {
      const fAg = iaResult.fecha_agendada || fechaManual || fechaHoyTexto;
      const hAg = iaResult.hora_agendada  || horaManual  || "09:00";
      const titulo  = (iaResult.titulo?.trim().length > 2) ? iaResult.titulo : textoOriginal.split(' ').slice(0,5).join(' ');
      const resumen = iaResult.resumen || textoOriginal;
      guardarNotaFisica(titulo, textoOriginal, textoAHtml(resumen), urgente, `${fAg} ${hAg}`);

      const gcalLink = generarEnlaceCalendario(titulo, resumen, fAg, hAg);
      boxResp.innerHTML = `
        <div style="background:#e8f5e9; border-radius:10px; padding:14px;">
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; border-bottom:1px solid #c3e6cb; padding-bottom:8px; color:#155724;">
            <i class="fas fa-calendar-check"></i>
            <b>Evento detectado y guardado</b>
          </div>
          <div style="font-size:0.9rem; margin-bottom:12px;">
            <b>📌 ${titulo}</b><br>
            <span style="color:#666; font-size:0.82rem;">📅 ${fAg} a las ${hAg}</span><br>
            <span style="color:#555; font-size:0.82rem; margin-top:4px; display:block;">${resumen}</span>
          </div>
          <a href="${gcalLink}" target="_blank"
            style="display:flex; align-items:center; justify-content:center; gap:8px; background:#4285F4; color:white; padding:12px; border-radius:8px; text-decoration:none; font-weight:bold;">
            <i class="fas fa-calendar-plus"></i> Abrir en Google Calendar
          </a>
        </div>`;
      boxResp.style.display = "block";

    // ── NOTA ───────────────────────────────────────────────────
    } else {
      const titulo = (iaResult.titulo?.trim().length > 2)
        ? iaResult.titulo : textoOriginal.split(' ').slice(0, 5).join(' ') || "Nota de Campo";
      const resumen = iaResult.resumen || textoOriginal;
      const recordatorioStr = fechaManual ? `${fechaManual} ${horaManual || '09:00'}` : null;
      guardarNotaFisica(titulo, textoOriginal, textoAHtml(resumen), urgente, recordatorioStr);
      showToast(`Nota guardada: "${titulo}"`);
    }

    btn.disabled = false;
    msg.style.display = "none";

  } catch(e) {
    const tituloFallback = textoOriginal.split(' ').slice(0, 5).join(' ') || "Nota de Campo";
    const recVacio = fechaManual ? `${fechaManual} ${horaManual || '09:00'}` : null;
    guardarNotaFisica(tituloFallback, textoOriginal, textoOriginal, urgente, recVacio);
    btn.disabled = false;
    msg.style.display = "none";
    boxResp.innerHTML = `<div style="background:#f8d7da; color:#721c24; padding:10px; border-radius:8px; font-size:0.85rem;">
      <b><i class="fas fa-exclamation-triangle"></i> Error IA:</b> ${e.message}<br>
      <small>La nota fue guardada con título automático.</small>
    </div>`;
    boxResp.style.display = "block";
  }
}

// Ejecutar las acciones sugeridas por la wiki IA
async function ejecutarAccionWiki(indexAccion, tituloConsulta) {
  const acciones = window._wikiUltimasAcciones || [];
  const respuesta = window._wikiUltimaRespuesta || '';
  const accion    = acciones[indexAccion] || '';

  const accionLower = accion.toLowerCase();

  if (accionLower.includes('whatsapp') || accionLower.includes('enviar')) {
    const texto = `*${tituloConsulta}*\n\n${respuesta.replace(/<[^>]*>/g,'')}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');

  } else if (accionLower.includes('calendar') || accionLower.includes('agendar') || accionLower.includes('seguimiento')) {
    const hoy = getHoy();
    const gcalLink = generarEnlaceCalendario(accion, respuesta.replace(/<[^>]*>/g,'').substring(0,200), hoy, '09:00');
    window.open(gcalLink, '_blank');

  } else if (accionLower.includes('tarea')) {
    // Llenar el modal de nueva tarea
    const modal = document.getElementById('modal-tarea');
    const desc   = document.getElementById('tarea-descripcion');
    if (modal && desc) {
      desc.value = `${tituloConsulta} — ${accion}`;
      document.getElementById('tarea-fecha').value = getHoy();
      // Pre-seleccionar distribuidor si lo hay
      const sel = document.getElementById('tarea-distribuidor');
      if (sel) {
        sel.innerHTML = distribuidores.map(d => `<option value="${d.nombre}">${d.nombre}</option>`).join('');
      }
      modal.style.display = 'flex';
      // Cambiar a la tab de distribuidores para ver tareas
      switchTab('view-distrib', 'Distribuidores', null);
      setTimeout(() => cambiarTabDistrib('tareas'), 200);
    }

  } else if (accionLower.includes('informe') || accionLower.includes('reporte')) {
    switchTab('view-stats', 'Panel de Control', null);
    showToast('Ve a Estadísticas → Generar Reporte con IA');

  } else {
    // Copiar respuesta al portapapeles
    const texto = `${tituloConsulta}\n\n${respuesta.replace(/<[^>]*>/g,'')}`;
    navigator.clipboard.writeText(texto)
      .then(() => showToast('Información copiada al portapapeles'))
      .catch(() => showToast('Selecciona y copia el texto manualmente'));
  }
}

async function guardarNotaFisica(titulo, original, procesado, urgente, stringRecordatorio) {
  const nuevaNota = { 
    id: Date.now(), 
    fechaCreacion: new Date().toLocaleString(), 
    titulo: titulo, 
    textoOriginal: original, 
    textoHtml: procesado, 
    urgente: urgente, 
    recordatorio: stringRecordatorio 
  };
  
  try {
    if (db) {
      await db.collection("notas").doc(nuevaNota.id.toString()).set(nuevaNota);
    } else {
      notasGlobales.push(nuevaNota); 
      localStorage.setItem("notasGlobales", JSON.stringify(notasGlobales));
    }
    
    document.getElementById("texto-nota-central").value = ""; 
    document.getElementById("urgente-nota").checked = false; 
    document.getElementById("fecha-recordatorio").value = ""; 
    document.getElementById("hora-recordatorio").value = "";
    document.getElementById("panel-nota-nueva").style.display = "none"; 
    
    showToast("¡Nota Guardada!"); 
    renderizarNotasGlobales();
  } catch(e) {
    alert("Error guardando nota: " + e.message);
  }
}

function renderizarNotasGlobales() {
  const contenedor = document.getElementById("lista-notas-central");
  if (notasGlobales.length === 0) {
    contenedor.innerHTML = `<p style="text-align:center; color:#888;">No tienes notas guardadas.</p>`;
    return;
  }
  
  const ordenadas = [...notasGlobales].sort((a,b) => {
    return (b.urgente - a.urgente) || (b.id - a.id);
  });
  
  let htmlNotas = "";
  
  ordenadas.forEach(n => {
    let btnCalendario = "";
    
    if (n.recordatorio) {
      const parts = n.recordatorio.split(" ");
      const tituloEvento = (n.urgente ? "🔥 URGENTE: " : "📌 ") + n.titulo;
      const linkCal = generarEnlaceCalendario(tituloEvento, n.textoOriginal, parts[0], parts[1]);
      
      btnCalendario = `
      <a href="${linkCal}" target="_blank" style="display:block; background:#4285F4; color:white; padding:10px; border-radius:8px; text-align:center; text-decoration:none; font-weight:bold; margin-top:15px; box-shadow:0 2px 4px rgba(0,0,0,0.2);">
        <i class="fas fa-calendar-plus"></i> 📅 Guardar en Google Calendar
      </a>`;
    }

    let claseUrgente = n.urgente ? 'nota-urgente' : '';
    let iconoUrgente = n.urgente ? '🔥 ' : '';
    let textoWhatsapp = encodeURIComponent(`*${n.titulo}*\n\n${n.textoOriginal}`);

    htmlNotas += `
    <div class="contacto-card ${claseUrgente}" style="margin-bottom:10px; padding:10px;">
      <div style="font-size:0.75rem; color:#666; margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;">
        <span><i class="fas fa-clock"></i> ${n.fechaCreacion}</span>
        <div style="display:flex; gap:15px;">
          <i class="fab fa-whatsapp" style="color:#25D366; font-size:1.2rem; cursor:pointer;" onclick="window.open('https://wa.me/?text=${textoWhatsapp}', '_blank')"></i>
          <i class="fas fa-trash" style="color:red; font-size:1.1rem; cursor:pointer;" onclick="eliminarDato('notas', ${n.id})"></i>
        </div>
      </div>
      <div style="font-size:1rem; font-weight:bold; color:var(--primary); margin-bottom:5px; cursor:pointer;" onclick="toggleDirElement('body-nota-${n.id}', 'icon-nota-${n.id}')">
        ${iconoUrgente}${n.titulo} <i class="fas fa-caret-down" id="icon-nota-${n.id}" style="float:right; margin-top:3px;"></i>
      </div>
      <div id="body-nota-${n.id}" style="display:none; font-size:0.9rem; color:#444; border-top:1px solid #eee; padding-top:8px; margin-top:5px;">
        ${n.textoHtml}
        ${n.recordatorio ? `<div style="font-size:0.8rem; color:#17a2b8; font-weight:bold; margin-top:8px;"><i class="fas fa-clock"></i> Agendado para: ${n.recordatorio}</div>` : ''}
        ${btnCalendario}
      </div>
    </div>`;
  });
  
  contenedor.innerHTML = htmlNotas;
}

// ==========================================
// 9. RENDERIZADO GENERAL Y AUDITORÍA
// ==========================================
function renderizarApp() {
  // Preservar selecciones actuales ANTES de reconstruir los selects
  const selDistri = document.getElementById("distribuidor");
  const selVend   = document.getElementById("vendedor");
  const distribSalvado = selDistri ? selDistri.value : (JSON.parse(localStorage.getItem('formState') || '{}').distribuidor || '');
  const vendSalvado    = selVend   ? selVend.value   : (JSON.parse(localStorage.getItem('formState') || '{}').vendedor    || '');

  let distriOptions = "";
  distribuidores.forEach(d => {
    const sel = d.nombre === distribSalvado ? ' selected' : '';
    distriOptions += `<option value="${d.nombre}"${sel}>${d.nombre}</option>`;
  });
  
  if (selDistri) {
    selDistri.innerHTML = distriOptions;
  }
  
  // RENDERS EN AJUSTES Y CREACIONES (SOLUCIONA EL BUG)
  
  let htmlDistribuidores = "";
  distribuidores.forEach((d) => {
    let cantSups = d.supervisores ? d.supervisores.length : 0;
    htmlDistribuidores += `
      <div class="item" style="flex-direction:column; align-items:flex-start;">
        <div><b>${d.nombre}</b> <small>(${d.ciudad || 'Sin ciudad'})</small></div>
        <div style="width:100%; display:flex; justify-content:space-between; margin-top:5px; align-items:center;">
          <span><i class="fas fa-users"></i> ${cantSups} Sups.</span> 
          <div style="display:flex; gap:5px;">
            <button class="btn-icon" style="background:#6c757d; padding:4px 8px; width:auto;" onclick="cargarEdicionDistribuidor(${d.id})"><i class="fas fa-edit"></i></button>
            <button class="btn-icon delete" onclick="eliminarDato('distribuidores', ${d.id})" style="padding:4px 8px; width:auto; background:var(--danger);"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  });
  
  if (document.getElementById("lista-distribuidores-config")) {
    document.getElementById("lista-distribuidores-config").innerHTML = htmlDistribuidores;
  }
  
  let htmlVendConfig = "";
  vendedores.forEach((v) => {
    htmlVendConfig += `
      <div class="item" style="flex-direction:column; align-items:flex-start;">
        <div><b>${v.nombre}</b> <small>(${v.distribuidor})</small></div>
        <div style="width:100%; display:flex; justify-content:space-between; margin-top:5px; align-items:center;">
          <span><i class="fas fa-phone"></i> ${v.telefono}</span> 
          <div style="display:flex; gap:5px;">
            <button class="btn-icon" style="background:#6c757d; padding:4px 8px; width:auto;" onclick="cargarEdicionVendedor(${v.id})"><i class="fas fa-edit"></i></button>
            <button class="btn-icon delete" onclick="eliminarDato('vendedores', ${v.id})" style="padding:4px 8px; width:auto; background:var(--danger);"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      </div>`;
  });
  
  if (document.getElementById("lista-vendedores-config")) {
    document.getElementById("lista-vendedores-config").innerHTML = htmlVendConfig;
  }

  // Marcas en Ajustes
  let htmlMarcasConfig = "";
  marcas.forEach((m) => {
    const nombre = (typeof m === 'object') ? m.nombre : m;
    htmlMarcasConfig += `
      <div class="item" style="flex-direction:column; align-items:flex-start;">
        <div><b>${nombre}</b></div>
        <div style="width:100%; display:flex; justify-content:space-between; margin-top:5px; align-items:center;">
          <span class="badge-stats" style="background:#17a2b8;">Global</span> 
          <button class="btn-icon delete" onclick="eliminarDato('marcas', '${nombre}')" style="padding:4px 8px; width:auto; background:var(--danger);"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
  });
  
  if (document.getElementById("lista-marcas-config")) {
    document.getElementById("lista-marcas-config").innerHTML = htmlMarcasConfig;
  }

  // Cargar checklist estáticos
  let htmlDiario = "";
  aspectosDiarios.forEach((aspecto, index) => {
    htmlDiario += `<div class="cuali-item" style="color:var(--primary);"><span>${aspecto}</span><input type="checkbox" id="diario-${index}"></div>`;
  });
  if (document.getElementById("eval-diaria-container")) {
    document.getElementById("eval-diaria-container").innerHTML = htmlDiario;
  }
  
  let htmlVisita = "";
  aspectosVisita.forEach((aspecto, index) => {
    htmlVisita += `<div class="cuali-item"><span>${aspecto}</span><input type="checkbox" id="visita-${index}"></div>`;
  });
  if (document.getElementById("eval-visita-container")) {
    document.getElementById("eval-visita-container").innerHTML = htmlVisita;
  }

  // POP se renderiza completamente en actualizarDependenciasAudit
  // (que tiene el contexto del distribuidor seleccionado)

  actualizarDependenciasAudit();
}

// MAGIA RELACIONAL: DISTRIBUIDOR -> VENDEDORES Y MARCAS
function actualizarDependenciasAudit() {
  const selectDistri = document.getElementById("distribuidor");
  if (!selectDistri) return;
  
  const distriSeleccionado = selectDistri.value;
  
  // 1. Mostrar solo vendedores de este distribuidor, preservando selección actual
  const vendFiltrados = vendedores.filter(v => v.distribuidor === distriSeleccionado);
  const selectVendedor = document.getElementById("vendedor");
  // Guardar vendedor actual antes de reconstruir
  const vendActual = selectVendedor?.value || (JSON.parse(localStorage.getItem('formState') || '{}').vendedor || '');
  
  if (vendFiltrados.length === 0) {
    selectVendedor.innerHTML = `<option value="">Sin vendedores en ruta</option>`;
  } else {
    let htmlVends = "";
    vendFiltrados.forEach(v => {
      const sel = v.nombre === vendActual ? ' selected' : '';
      htmlVends += `<option value="${v.nombre}"${sel}>${v.nombre}</option>`;
    });
    selectVendedor.innerHTML = htmlVends;
  }

  // Intentar restaurar el vendedor guardado en formState (por si renderizarApp corrió primero)
  if (window._pendingVendedorRestore) {
    const optVend = [...(selectVendedor?.options || [])].find(o => o.value === window._pendingVendedorRestore);
    if (optVend) {
      selectVendedor.value = window._pendingVendedorRestore;
      window._pendingVendedorRestore = null;
    }
  }
  
  // 2. Mostrar solo marcas asignadas a este distribuidor
  const distriObj = distribuidores.find(d => d.nombre === distriSeleccionado);
  const vendeDuracell = distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.includes('Duracell');
  
  const marcasFiltradas = (distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.length > 0)
    ? marcas.filter(m => { const nombre = (typeof m === 'object') ? m.nombre : m; return distriObj.marcasAsignadas.includes(nombre); })
    : marcas;
  const contenedorMarcas = document.getElementById("marcas-senso");
  
  if (marcasFiltradas.length === 0) {
    contenedorMarcas.innerHTML = `<p style="color:#888; font-size:0.9rem;">Sin marcas asignadas a este distribuidor.</p>`;
  } else {
    let htmlMarcas = "";
    marcasFiltradas.forEach((m, i) => {
      const nombre = (typeof m === 'object') ? m.nombre : m;
      htmlMarcas += `<div class="marca-item"><span>${nombre}</span><input type="checkbox" data-marca="${nombre}" id="check-marca-${i}" onchange="saveFormState()"></div>`;
    });
    contenedorMarcas.innerHTML = htmlMarcas;
  }
  
  // 3. Mostrar/ocultar Ganchera Duracell en POP según si el distribuidor vende Duracell
  const popContainer = document.getElementById("pop-container");
  const popBaseItems = materialesPOP.filter(p => !p.toLowerCase().includes('duracell'));
  let htmlPop = "";
  popBaseItems.forEach((pop, index) => {
    htmlPop += `<div class="cuali-item"><span>${pop}</span><input type="checkbox" id="pop-${index}" onchange="saveFormState()"></div>`;
  });
  if (vendeDuracell) {
    const duracellPop = materialesPOP.find(p => p.toLowerCase().includes('duracell'));
    if (duracellPop) {
      const duracellIndex = materialesPOP.indexOf(duracellPop);
      htmlPop += `<div class="cuali-item"><span>${duracellPop}</span><input type="checkbox" id="pop-${duracellIndex}" onchange="saveFormState()"></div>`;
    }
  }
  if (popContainer) popContainer.innerHTML = htmlPop;
  
  // 4. Mostrar/ocultar casilla Compró Duracell
  const filaCompDuracell = document.getElementById('fila-compro-duracell');
  if (filaCompDuracell) filaCompDuracell.style.display = vendeDuracell ? 'flex' : 'none';

  // 5. Formularios ocultos de creación (Ajustes)
  if (document.getElementById("config-vend-distri")) {
    let distriOptions = "";
    distribuidores.forEach(d => {
      distriOptions += `<option value="${d.nombre}">${d.nombre}</option>`;
    });
    document.getElementById("config-vend-distri").innerHTML = distriOptions;
  }

  if (document.getElementById("config-marca-distri")) {
    let distriOptions = `<option value="Todos">Todos los distribuidores</option>`;
    distribuidores.forEach(d => {
      distriOptions += `<option value="${d.nombre}">${d.nombre}</option>`;
    });
    document.getElementById("config-marca-distri").innerHTML = distriOptions;
  }
  
  // 6. Restaurar checkboxes pendientes
  if (window._pendingMarcasRestore) {
    setTimeout(() => {
      Object.keys(window._pendingMarcasRestore).forEach(marca => {
        const el = document.querySelector(`#marcas-senso input[data-marca="${marca}"]`);
        if (el) el.checked = window._pendingMarcasRestore[marca];
      });
    }, 100);
  }
  if (window._pendingVisitaRestore) {
    setTimeout(() => {
      Object.keys(window._pendingVisitaRestore).forEach(i => {
        const el = document.getElementById(`visita-${i}`);
        if (el) el.checked = window._pendingVisitaRestore[i];
      });
    }, 100);
  }
  if (window._pendingPopRestore) {
    setTimeout(() => {
      Object.keys(window._pendingPopRestore).forEach(i => {
        const el = document.getElementById(`pop-${i}`);
        if (el) el.checked = window._pendingPopRestore[i];
      });
    }, 100);
  }
  
  verificarEvaluacionDiaria();
  saveFormState();
  actualizarBtnInicioRuta();
}

function verificarEvaluacionDiaria() {
  const vendedorEl = document.getElementById("vendedor");
  if (!vendedorEl) return;
  
  const vendedor = vendedorEl.value;
  
  if (!vendedor) { 
    document.getElementById("eval-diaria-container").style.display = "none"; 
    document.getElementById("alerta-compromisos").style.display = "none"; 
    return; 
  }
  
  const visitasHoy = visitas.filter(v => v.fechaISO === getHoy() && v.vendedor === vendedor);
  
  if (visitasHoy.length > 0) { 
    document.getElementById("eval-diaria-container").style.display = "none"; 
    document.getElementById("msg-eval-diaria").style.display = "block"; 
    document.getElementById("msg-eval-diaria").innerHTML = `<i class="fas fa-check-double"></i> <b>${vendedor}</b> ya evaluado en presentación hoy.`; 
  } else { 
    document.getElementById("eval-diaria-container").style.display = "block"; 
    document.getElementById("msg-eval-diaria").style.display = "none"; 
    aspectosDiarios.forEach((_, i) => document.getElementById(`diario-${i}`).checked = false); 
  }

  const alerta = document.getElementById("alerta-compromisos"); 
  const visitasPasadas = visitas.filter(v => v.vendedor === vendedor && v.fechaISO !== getHoy());
  
  if (visitasPasadas.length > 0) {
    visitasPasadas.sort((a,b) => new Date(b.fechaISO) - new Date(a.fechaISO));
    const ultimaVisita = visitasPasadas[0];
    
    let fallas = [];
    if (ultimaVisita.evaluacionVisita) {
      ultimaVisita.evaluacionVisita.forEach(e => {
        if (!e.cumple) {
          fallas.push(e.aspecto);
        }
      });
    }
    
    if(fallas.length > 0) { 
      alerta.style.display = "block"; 
      let fallasHtml = "";
      fallas.forEach(f => fallasHtml += `<li>${f}</li>`);
      alerta.innerHTML = `<strong><i class="fas fa-history"></i> Coaching Pasado:</strong> Falló en: <ul style="margin:5px 0 0 20px;">${fallasHtml}</ul> <b>¡Haz énfasis hoy!</b>`; 
    } else { 
      alerta.style.display = "none"; 
    }
  } else { 
    alerta.style.display = "none"; 
  }
}

// ==========================================
// 10. MÓDULO CRUD (EMPRESAS, VENDEDORES, MARCAS)
// ==========================================
// === HELPER: Poblar el checklist de marcas en el formulario de distribuidor ===
function renderMarcasDistribuidor(seleccionadas = []) {
  const contenedor = document.getElementById("config-dist-marcas-container");
  if (!contenedor) return;
  let html = "";
  marcas.forEach(m => {
    const nombre = (typeof m === 'object') ? m.nombre : m;
    const checked = seleccionadas.includes(nombre) ? 'checked' : '';
    html += `<div class="cuali-item"><span>${nombre}</span><input type="checkbox" class="marca-dist-check" data-marca="${nombre}" ${checked} style="width:20px;height:20px;accent-color:var(--primary);"></div>`;
  });
  contenedor.innerHTML = html || `<p style="color:#888;font-size:0.85rem;">No hay marcas en el portafolio global aún.</p>`;
}

function abrirModalCrear(tipo) {
  if (tipo === 'vendedor') {
    if (distribuidores.length === 0) return alert("Primero debes crear un distribuidor.");
    
    document.getElementById("config-vend-id").value = ""; 
    document.getElementById("config-vend-nombre").value = ""; 
    document.getElementById("config-vend-doc").value = ""; 
    document.getElementById("config-vend-tel").value = "";
    
    document.getElementById("titulo-form-vend").innerHTML = `<i class="fas fa-user-plus"></i> Nuevo Vendedor`;
    switchTab('view-form-vendedor', 'Crear Vendedor');
  } else {
    document.getElementById("config-dist-id").value = ""; 
    document.getElementById("config-dist-nombre").value = ""; 
    document.getElementById("config-dist-ciudad").value = ""; 
    document.getElementById("config-dist-direccion").value = ""; 
    document.getElementById("config-dist-vendedores").value = ""; 
    document.getElementById("config-dist-clientes").value = "";
    
    supervisoresTemp = []; 
    renderSupTemp();
    renderMarcasDistribuidor([]); // Checklist de marcas vacío para nueva empresa
    
    document.getElementById("titulo-form-dist").innerHTML = `<i class="fas fa-truck"></i> Nueva Empresa`;
    switchTab('view-form-distribuidor', 'Crear Distribuidor');
  }
}

function cargarEdicionDistribuidor(id) {
  const dist = distribuidores.find(d => d.id === id);
  if (!dist) return;

  editandoDistribuidorId = id; 
  document.getElementById("config-dist-id").value = dist.id;
  document.getElementById("config-dist-nombre").value = dist.nombre;
  document.getElementById("config-dist-ciudad").value = dist.ciudad || "";
  document.getElementById("config-dist-direccion").value = dist.direccion || "";
  document.getElementById("config-dist-vendedores").value = dist.vendedores || "";
  document.getElementById("config-dist-clientes").value = dist.clientes || "";
  
  supervisoresTemp = dist.supervisores ? [...dist.supervisores] : [];
  renderSupTemp();
  renderMarcasDistribuidor(dist.marcasAsignadas || []);
  
  document.getElementById("titulo-form-dist").innerHTML = `<i class="fas fa-edit"></i> Editar Empresa`;
  switchTab('view-form-distribuidor', 'Editar Distribuidor');
}

function cargarEdicionVendedor(id) {
  const vend = vendedores.find(v => v.id === id);
  if (!vend) return;

  editandoVendedorId = id; 
  document.getElementById("config-vend-id").value = vend.id;
  document.getElementById("config-vend-nombre").value = vend.nombre;
  document.getElementById("config-vend-doc").value = vend.documento || "";
  document.getElementById("config-vend-tel").value = vend.telefono;
  
  let opts = "";
  distribuidores.forEach(d => {
    let sel = (d.nombre === vend.distribuidor) ? 'selected' : '';
    opts += `<option value="${d.nombre}" ${sel}>${d.nombre}</option>`;
  });
  document.getElementById("config-vend-distri").innerHTML = opts;
  
  document.getElementById("titulo-form-vend").innerHTML = `<i class="fas fa-user-edit"></i> Editar Vendedor`;
  switchTab('view-form-vendedor', 'Editar Vendedor');
}

function addSupTemp() { 
  const nom = document.getElementById("config-sup-nombre").value.trim(); 
  const tel = document.getElementById("config-sup-tel").value.trim(); 
  
  if (!nom || !tel) {
    return alert("Escribe un nombre y teléfono para el supervisor."); 
  }
  
  supervisoresTemp.push({ nombre: nom, telefono: tel }); 
  document.getElementById("config-sup-nombre").value = ""; 
  document.getElementById("config-sup-tel").value = ""; 
  renderSupTemp(); 
}

function renderSupTemp() { 
  let html = "";
  supervisoresTemp.forEach((s, i) => {
    html += `
    <div style="font-size:0.85rem; background:#fff; border:1px solid #eee; padding:5px; margin-bottom:3px; display:flex; justify-content:space-between; border-radius:5px;">
      <span><i class="fas fa-user-shield"></i> ${s.nombre} - ${s.telefono}</span>
      <i class="fas fa-times" style="color:red; cursor:pointer;" onclick="supervisoresTemp.splice(${i},1); renderSupTemp();"></i>
    </div>`;
  });
  document.getElementById("lista-sups-temp").innerHTML = html;
}

// === EL GUARDADO MAESTRO DE DISTRIBUIDORES ===
async function guardarDistribuidor() { 
  const idEdit = document.getElementById("config-dist-id").value;
  const nom = document.getElementById("config-dist-nombre").value.trim(); 
  const ciu = document.getElementById("config-dist-ciudad").value.trim(); 
  const dir = document.getElementById("config-dist-direccion").value.trim(); 
  const ven = document.getElementById("config-dist-vendedores").value.trim(); 
  const cli = document.getElementById("config-dist-clientes").value.trim();
  
  if (!nom) return alert("El Nombre de la Distribuidora es obligatorio.");

  // Autoguardado si llenaron la caja pero no le dieron al "+"
  const supNomPendiente = document.getElementById("config-sup-nombre").value.trim(); 
  const supTelPendiente = document.getElementById("config-sup-tel").value.trim();
  if (supNomPendiente && supTelPendiente) {
    supervisoresTemp.push({ nombre: supNomPendiente, telefono: supTelPendiente });
  }

  // Leer las marcas seleccionadas para este distribuidor
  const marcasSeleccionadas = [];
  document.querySelectorAll(".marca-dist-check:checked").forEach(cb => {
    marcasSeleccionadas.push(cb.dataset.marca);
  });

  try {
    if (idEdit) {
      let dist = distribuidores.find(d => d.id == idEdit);
      if (dist) {
        dist.nombre = nom; 
        dist.ciudad = ciu; 
        dist.direccion = dir; 
        dist.vendedores = ven; 
        dist.clientes = cli; 
        dist.supervisores = [...supervisoresTemp];
        dist.marcasAsignadas = marcasSeleccionadas;
        
        if (db) {
          await db.collection("distribuidores").doc(idEdit.toString()).set(dist);
        } else {
          localStorage.setItem("distribuidores", JSON.stringify(distribuidores));
        }
      }
      showToast("Distribuidor Actualizado");
      editandoDistribuidorId = null;
    } else {
      const obj = { 
        id: Date.now(), 
        nombre: nom, 
        ciudad: ciu, 
        direccion: dir, 
        vendedores: ven, 
        clientes: cli, 
        supervisores: [...supervisoresTemp],
        marcasAsignadas: marcasSeleccionadas
      };
      
      if (db) {
        await db.collection("distribuidores").doc(obj.id.toString()).set(obj);
      } else {
        distribuidores.push(obj); 
        localStorage.setItem("distribuidores", JSON.stringify(distribuidores)); 
      }
      showToast("Distribuidor Creado");
    }
    
    document.getElementById("config-dist-id").value = "";
    document.getElementById("config-dist-nombre").value = ""; 
    document.getElementById("config-dist-ciudad").value = ""; 
    document.getElementById("config-dist-direccion").value = ""; 
    document.getElementById("config-dist-vendedores").value = ""; 
    document.getElementById("config-dist-clientes").value = ""; 
    document.getElementById("config-sup-nombre").value = ""; 
    document.getElementById("config-sup-tel").value = ""; 
    
    supervisoresTemp = []; 
    renderSupTemp(); 
    renderizarApp(); 
    
    switchTab('view-directorio', 'Directorio CRM'); 
    cambiarVistaDir('distribuidores');
  } catch (e) {
    alert("Error de guardado: " + e.message);
  }
}

// === EL GUARDADO MAESTRO DE VENDEDORES ===
async function agregarVendedor() { 
  const idEdit = document.getElementById("config-vend-id").value;
  const distri = document.getElementById("config-vend-distri").value; 
  const nombre = document.getElementById("config-vend-nombre").value.trim(); 
  const doc = document.getElementById("config-vend-doc").value.trim(); 
  const tel = document.getElementById("config-vend-tel").value.trim();
  
  if (!distri || !nombre || !tel) {
    return alert("Empresa, Nombre y Teléfono son obligatorios."); 
  }
  
  try {
    if (idEdit) {
      let ven = vendedores.find(v => v.id == idEdit);
      if (ven) { 
        ven.distribuidor = distri; 
        ven.nombre = nombre; 
        ven.documento = doc; 
        ven.telefono = tel; 
      }
      if (db) {
        await db.collection("vendedores").doc(idEdit.toString()).set(ven);
      } else {
        localStorage.setItem("vendedoresObj", JSON.stringify(vendedores));
      }
      showToast("Vendedor Actualizado");
      editandoVendedorId = null;
    } else {
      const obj = { id: Date.now(), distribuidor: distri, nombre: nombre, documento: doc, telefono: tel };
      if (db) {
        await db.collection("vendedores").doc(obj.id.toString()).set(obj); 
      } else {
        vendedores.push(obj); 
        localStorage.setItem("vendedoresObj", JSON.stringify(vendedores)); 
      }
      showToast("Vendedor Creado"); 
    }
    
    document.getElementById("config-vend-id").value = "";
    document.getElementById("config-vend-nombre").value = ""; 
    document.getElementById("config-vend-doc").value = ""; 
    document.getElementById("config-vend-tel").value = ""; 
    
    renderizarApp(); 
    switchTab('view-directorio', 'Directorio CRM'); 
    cambiarVistaDir('vendedores');
  } catch(e) {
    alert("Error: " + e.message);
  }
}

// === EL GUARDADO DE MARCAS MULTICANAL ===
async function agregarMarca() { 
  const input = document.getElementById("nuevaMarca").value.trim(); 
  if (!input) return;

  // Las marcas son ahora strings globales (sin asignación de distribuidor directa)
  // La asignación se hace por distribuidor en su formulario propio
  if (marcas.some(m => { const n = (typeof m === 'object') ? m.nombre : m; return n.toLowerCase() === input.toLowerCase(); })) {
    return alert("Esa marca ya existe en el portafolio.");
  }

  try {
    if (db) {
      marcas.push(input);
      await db.collection("marcas").doc("globales").set({ lista: marcas });
    } else {
      marcas.push(input); 
      localStorage.setItem("marcas", JSON.stringify(marcas)); 
      renderizarApp(); 
    }
    document.getElementById("nuevaMarca").value = ""; 
    showToast("Marca Agregada al Portafolio"); 
  } catch(e) { 
    alert("Error guardando marca: " + e.message); 
  }
}

// ELIMINADOR MAESTRO (NUBE Y LOCAL)
async function eliminarDato(tipo, id_o_nombre) { 
  if (!confirm("¿Eliminar registro permanentemente?")) return; 
  
  try {
    if (db) {
      if (tipo === 'distribuidores') await db.collection("distribuidores").doc(id_o_nombre.toString()).delete();
      if (tipo === 'vendedores') await db.collection("vendedores").doc(id_o_nombre.toString()).delete();
      if (tipo === 'notas') await db.collection("notas").doc(id_o_nombre.toString()).delete();
      
      if (tipo === 'marcas') {
        marcas = marcas.filter(m => m.nombre !== id_o_nombre);
        await db.collection("marcas").doc("globales").set({ lista: marcas });
      }
    } else {
      if (tipo === 'distribuidores') { 
        distribuidores = distribuidores.filter(d => d.id !== id_o_nombre); 
        localStorage.setItem("distribuidores", JSON.stringify(distribuidores)); 
      }
      if (tipo === 'vendedores') { 
        vendedores = vendedores.filter(v => v.id !== id_o_nombre); 
        localStorage.setItem("vendedoresObj", JSON.stringify(vendedores)); 
      }
      if (tipo === 'notas') { 
        notasGlobales = notasGlobales.filter(n => n.id !== id_o_nombre); 
        localStorage.setItem("notasGlobales", JSON.stringify(notasGlobales)); 
      }
      if (tipo === 'marcas') { 
        marcas = marcas.filter(m => m.nombre !== id_o_nombre);
        localStorage.setItem("marcas", JSON.stringify(marcas)); 
      }
      
      renderizarApp();
      if (tipo === 'distribuidores' || tipo === 'vendedores') renderizarDirectorio();
      if (tipo === 'notas') renderizarNotasGlobales();
    }
    showToast("Eliminado con éxito");
  } catch(e) { 
    alert("Error eliminando: " + e.message); 
  }
}

function guardarGCal() { 
  let input = document.getElementById("gcal-id").value.trim(); 
  if (input.includes('src="')) { 
    const match = input.match(/src="([^"]+)"/); 
    if (match) { 
      try { 
        const urlObj = new URL(match[1]); 
        input = urlObj.searchParams.get("src") || input; 
      } catch(e){} 
    } 
  } else if (input.startsWith("http")) { 
    try { 
      const urlObj = new URL(input); 
      input = urlObj.searchParams.get("src") || input; 
    } catch(e){} 
  } 
  googleCalendarId = input; 
  localStorage.setItem("gcalId", googleCalendarId); 
  showToast("Calendario Guardado"); 
}

function guardarGemini() { 
  geminiApiKey = document.getElementById("gemini-key").value.trim(); 
  localStorage.setItem("geminiKey", geminiApiKey); 
  setIAStatus(geminiApiKey ? 'ok' : 'idle');
  showToast("Clave IA Guardada"); 
}

function exportarBackup() { 
  const data = { 
    vendedoresObj:       vendedores, 
    marcas:              marcas, 
    visitas:             visitas, 
    distribuidores:      distribuidores, 
    gcalId:              googleCalendarId, 
    geminiKey:           geminiApiKey, 
    notas:               notasGlobales,
    informesGuardados:   informesGuardados,
    datosHistorialEdit:  datosHistorialEdit,
    tareasDistrib:       tareasDistrib,
    cuotasDistrib:       cuotasDistrib,
    incentivosDistrib:   incentivosDistrib,
    firebaseConfig:      (() => { try { return JSON.parse(localStorage.getItem('firebaseConfig') || 'null'); } catch(_){return null;} })()
  }; 
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"}); 
  const link = document.createElement("a"); 
  link.href = URL.createObjectURL(blob); 
  link.download = `Backup_GenommaLab_${getHoy()}.json`; 
  link.click(); 
  showToast('Backup descargado ✅');
}

function importarBackup(event) { 
  const file = event.target.files[0]; 
  if(!file) return; 
  
  const reader = new FileReader(); 
  reader.onload = async function(e) { 
    try { 
      const data = JSON.parse(e.target.result); 
      if (!data.visitas) return alert("Archivo de backup inválido o incompleto.");

      // 1. Guardar todo en localStorage
      localStorage.setItem("vendedoresObj",      JSON.stringify(data.vendedoresObj      || []));
      localStorage.setItem("marcas",             JSON.stringify(data.marcas             || []));
      localStorage.setItem("visitas",            JSON.stringify(data.visitas            || []));
      localStorage.setItem("distribuidores",     JSON.stringify(data.distribuidores     || []));
      localStorage.setItem("notasGlobales",      JSON.stringify(data.notas              || []));
      localStorage.setItem("informesGuardados",  JSON.stringify(data.informesGuardados  || []));
      localStorage.setItem("datosHistorialEdit", JSON.stringify(data.datosHistorialEdit || {}));
      localStorage.setItem("tareasDistrib",      JSON.stringify(data.tareasDistrib      || {}));
      localStorage.setItem("cuotasDistrib",      JSON.stringify(data.cuotasDistrib      || {}));
      localStorage.setItem("incentivosDistrib",  JSON.stringify(data.incentivosDistrib  || {}));

      if (data.gcalId)         localStorage.setItem("gcalId",        data.gcalId);
      if (data.geminiKey)      localStorage.setItem("geminiKey",     data.geminiKey);
      if (data.firebaseConfig) localStorage.setItem("firebaseConfig", JSON.stringify(data.firebaseConfig));

      // 2. Si Firebase está activo, también subir a la nube ANTES de recargar
      //    Esto evita que los listeners de Firestore sobrescriban el backup al recargar
      if (db) {
        const btnImport = document.getElementById('input-importar');
        showToast('Subiendo backup a Firebase…');
        
        // Actualizar variables en memoria para migrarAFirebase
        distribuidores  = data.distribuidores  || [];
        vendedores      = data.vendedoresObj   || [];
        marcas          = (data.marcas         || []).map(m => typeof m === 'object' ? m.nombre : m);
        visitas         = data.visitas         || [];
        notasGlobales   = data.notas           || [];

        try {
          // Subir en lotes
          for (let d of distribuidores) {
            await db.collection("distribuidores").doc(d.id.toString()).set(d);
          }
          for (let v of vendedores) {
            await db.collection("vendedores").doc(v.id.toString()).set(v);
          }
          await db.collection("marcas").doc("globales").set({ lista: marcas });
          for (let i = 0; i < visitas.length; i += 400) {
            const lote = db.batch();
            visitas.slice(i, i + 400).forEach(v => {
              lote.set(db.collection("visitas").doc(v.id.toString()), v);
            });
            await lote.commit();
          }
          for (let n of notasGlobales) {
            await db.collection("notas").doc(n.id.toString()).set(n);
          }
          alert("✅ Backup restaurado y subido a Firebase. La app se recargará.");
        } catch(fbErr) {
          alert(`✅ Backup guardado localmente. No se pudo subir a Firebase: ${fbErr.message}\nLa app se recargará.`);
        }
      } else {
        alert("✅ Backup restaurado. La aplicación se recargará.");
      }

      location.reload(); 
    } catch(err) { 
      alert("❌ Error al leer el archivo de backup. Verifica que sea un JSON válido."); 
    } 
  }; 
  reader.readAsText(file); 
}

// ==========================================
// 11. DIRECTORIO CRM VISUAL (CONTACTOS Y EMPRESAS)
// ==========================================
function cambiarVistaDir(vista) {
  document.getElementById('tab-dir-vend').classList.remove('active'); 
  document.getElementById('tab-dir-dist').classList.remove('active'); 
  document.getElementById('lista-directorio-vendedores').style.display = 'none'; 
  document.getElementById('lista-directorio-distribuidores').style.display = 'none';
  
  if (vista === 'vendedores') { 
    document.getElementById('tab-dir-vend').classList.add('active'); 
    document.getElementById('lista-directorio-vendedores').style.display = 'block'; 
  } else { 
    document.getElementById('tab-dir-dist').classList.add('active'); 
    document.getElementById('lista-directorio-distribuidores').style.display = 'block'; 
  } 
  renderizarDirectorio();
}

function renderizarDirectorio() {
  const filtro = document.getElementById("buscar-directorio").value.toLowerCase();
  
  // VENDEDORES
  const cVend = document.getElementById("lista-directorio-vendedores"); 
  let todosLosContactos = [];

  vendedores.forEach(v => { 
    todosLosContactos.push({ ...v, tipo: 'Vendedor' }); 
  });

  distribuidores.forEach(d => {
    if (d.supervisores && d.supervisores.length > 0) {
      d.supervisores.forEach(s => {
        todosLosContactos.push({ nombre: s.nombre, telefono: s.telefono, distribuidor: d.nombre, tipo: 'Supervisor' });
      });
    }
  });

  const contactosFiltrados = todosLosContactos.filter(c => c.nombre.toLowerCase().includes(filtro) || c.distribuidor.toLowerCase().includes(filtro));
  
  if (contactosFiltrados.length === 0) {
    cVend.innerHTML = `<p style="text-align:center; color:#888;">Sin contactos registrados.</p>`;
  } else {
    let htmlContactos = "";
    contactosFiltrados.forEach(c => {
      const inicial = c.nombre.charAt(0).toUpperCase();
      const colorBadge = c.tipo === 'Vendedor' ? 'var(--primary)' : '#673AB7'; 

      const btnEditar = (c.tipo === 'Vendedor' && c.id) ? `<i class="fas fa-edit" style="color:#6c757d; cursor:pointer; font-size:1.1rem; margin-right:10px;" onclick="cargarEdicionVendedor(${c.id})"></i>` : "";
      
      htmlContactos += `
      <div class="contacto-card">
        <div class="contacto-header" style="justify-content: flex-start; gap: 15px;">
          <div class="avatar" style="background:${colorBadge}">${inicial}</div>
          <div style="flex:1;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
               <h4 style="margin:0;">${c.nombre}</h4>
               <div>${btnEditar}</div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
              <span style="font-size:0.75rem; color:#888; font-weight:bold;">${c.distribuidor}</span>
              <span class="badge-stats" style="background:${colorBadge}; padding:2px 6px; font-size:0.65rem;">${c.tipo}</span>
            </div>
          </div>
        </div>
        <div class="contacto-body">
          ${c.documento ? `<p><i class="fas fa-id-card"></i> Doc: ${c.documento}</p>` : ''}
          <p><i class="fas fa-phone"></i> Cel: ${c.telefono}</p>
        </div>
        <div class="contacto-actions">
          <a href="tel:${c.telefono}" class="btn-llamar"><i class="fas fa-phone-alt"></i> Llamar</a>
          <a href="https://wa.me/57${c.telefono}" target="_blank" class="btn-wa"><i class="fab fa-whatsapp"></i> WA</a>
        </div>
      </div>`;
    });
    cVend.innerHTML = htmlContactos;
  }

  // DISTRIBUIDORES
  const cDist = document.getElementById("lista-directorio-distribuidores"); 
  const distFiltrados = distribuidores.filter(d => d.nombre.toLowerCase().includes(filtro) || (d.ciudad && d.ciudad.toLowerCase().includes(filtro)));
  
  if (distFiltrados.length === 0) {
    cDist.innerHTML = `<p style="text-align:center; color:#888;">Sin distribuidores.</p>`;
  } else {
    let htmlDist = "";
    distFiltrados.forEach((d, i) => {
      
      const vendsDeDistri = vendedores.filter(v => v.distribuidor === d.nombre);
      
      let htmlVendedoresList = vendsDeDistri.length > 0 ? vendsDeDistri.map(v => `
        <div class="sup-card" style="border-left:3px solid var(--primary); margin-top:5px; margin-bottom:5px;">
          <b>${v.nombre}</b><br><small><i class="fas fa-phone"></i> ${v.telefono}</small>
          <div class="contacto-actions" style="margin-top:8px;">
            <a href="tel:${v.telefono}" class="btn-llamar" style="background:#007bff; padding:6px;"><i class="fas fa-phone-alt"></i></a>
            <a href="https://wa.me/57${v.telefono}" target="_blank" class="btn-wa" style="padding:6px;"><i class="fab fa-whatsapp"></i> WA</a>
          </div>
        </div>`).join('') : '<p style="margin-top:10px; font-size:0.8rem; color:#999; text-align:center;">Sin vendedores asignados.</p>';

      let htmlSupsList = (d.supervisores && d.supervisores.length > 0) ? d.supervisores.map(s => `
        <div class="sup-card" style="border-left:3px solid #673AB7; margin-top:5px; margin-bottom:5px;">
          <b>${s.nombre}</b><br><small><i class="fas fa-phone"></i> ${s.telefono}</small>
          <div class="contacto-actions" style="margin-top:8px;">
            <a href="tel:${s.telefono}" class="btn-llamar" style="background:#6c757d; padding:6px;"><i class="fas fa-phone-alt"></i></a>
            <a href="https://wa.me/57${s.telefono}" target="_blank" class="btn-wa" style="padding:6px;"><i class="fab fa-whatsapp"></i> WA</a>
          </div>
        </div>`).join('') : '<p style="margin-top:10px; font-size:0.8rem; color:#999; text-align:center;">Sin supervisores asignados.</p>';

      htmlDist += `
      <div class="contacto-card" style="border-left-color:#673AB7; padding:0; overflow:hidden;">
        
        <div class="sesion-header" style="background:white; color:#333; border-bottom:1px solid #eee; padding:15px; display:flex; justify-content:space-between; align-items:center;">
          <div style="flex:1; cursor:pointer;" onclick="toggleDirElement('dist-body-${i}', 'icon-dist-${i}')">
             <h4 style="margin:0; color:#673AB7;"><i class="fas fa-truck"></i> ${d.nombre}</h4>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
             <i class="fas fa-edit" style="color:#6c757d; font-size:1.1rem; cursor:pointer;" onclick="cargarEdicionDistribuidor(${d.id})"></i>
             <i class="fas fa-chevron-down toggle-icon" id="icon-dist-${i}" style="color:#666; position:relative; right:0; top:0; cursor:pointer;" onclick="toggleDirElement('dist-body-${i}', 'icon-dist-${i}')"></i>
          </div>
        </div>
        
        <div id="dist-body-${i}" style="display:none; padding:15px; background:#fbfbfb;">
          <p style="font-size:0.85rem; color:#666; margin-bottom:5px;"><i class="fas fa-map-marker-alt" style="width:20px; color:#673AB7; text-align:center;"></i> ${d.ciudad || 'N/A'}</p>
          <p style="font-size:0.85rem; color:#666; margin-bottom:15px;"><i class="fas fa-map-signs" style="width:20px; color:#673AB7; text-align:center;"></i> ${d.direccion || 'N/A'}</p>
          
          <div style="margin-bottom:15px; font-size:0.85rem; text-align:center; background:#eee; padding:5px; border-radius:5px;">
            <b>Clientes en maestra:</b> ${d.clientes || '0'}
          </div>

          <div style="background:#fff; border:1px solid #ddd; border-radius:8px; margin-bottom:10px;">
            <div style="padding:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="toggleDirElement('dist-vend-${i}', 'icon-vend-${i}')">
              <span style="font-weight:bold; font-size:0.9rem; color:var(--primary);"><i class="fas fa-user-tie"></i> Vendedores de ruta (${vendsDeDistri.length})</span>
              <i class="fas fa-chevron-down" id="icon-vend-${i}" style="color:#999; font-size:0.9rem;"></i>
            </div>
            <div id="dist-vend-${i}" style="display:none; padding:0 10px 10px 10px; border-top:1px solid #eee;">
              ${htmlVendedoresList}
            </div>
          </div>

          <div style="background:#fff; border:1px solid #ddd; border-radius:8px;">
            <div style="padding:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="toggleDirElement('dist-sup-${i}', 'icon-sup-${i}')">
              <span style="font-weight:bold; font-size:0.9rem; color:#673AB7;"><i class="fas fa-user-shield"></i> Supervisores a Cargo (${d.supervisores ? d.supervisores.length : 0})</span>
              <i class="fas fa-chevron-down" id="icon-sup-${i}" style="color:#999; font-size:0.9rem;"></i>
            </div>
            <div id="dist-sup-${i}" style="display:none; padding:0 10px 10px 10px; border-top:1px solid #eee;">
              ${htmlSupsList}
            </div>
          </div>
        </div>
      </div>`;
    });
    cDist.innerHTML = htmlDist;
  }
}

// ==========================================
// 12. GUARDAR VISITA AUDITORÍA (GPS)
// ==========================================
function guardarVisita() {
  const distribuidor = document.getElementById("distribuidor").value; 
  const vendedor = document.getElementById("vendedor").value; 
  const zona = document.getElementById("zona").value.trim(); 
  const tienda = document.getElementById("tienda").value.trim(); 
  const notas = document.getElementById("notas-visita").value.trim();
  const comentarioGeneral = document.getElementById("comentario-general-auditoria")?.value.trim() || "";
  
  if(!distribuidor || !vendedor || !zona || !tienda) {
    return alert("Llena campos obligatorios.");
  }
  
  const btnGuardar = document.getElementById("btn-guardar"); 
  btnGuardar.disabled = true; 
  btnGuardar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> GPS...';

  if (!navigator.geolocation) { 
    alert("Sin GPS. Se guardará sin coordenadas."); 
    ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, comentarioGeneral, "Sin datos", "Sin datos");
    return; 
  }
  
  navigator.geolocation.getCurrentPosition(
    (position) => { 
      ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, comentarioGeneral, position.coords.latitude, position.coords.longitude); 
    }, 
    (error) => { 
      alert("❌ GPS Falló. Asegúrate de dar permisos de ubicación."); 
      ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, comentarioGeneral, "Sin datos", "Sin datos");
    }, 
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function restaurarBoton() { 
  const btnGuardar = document.getElementById("btn-guardar"); 
  btnGuardar.disabled = false; 
  btnGuardar.innerHTML = '<i class="fas fa-save"></i> Guardar Registro Definitivo'; 
}

async function ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, comentarioGeneral, lat, lng) {
  let resultados = []; 
  document.querySelectorAll("#marcas-senso input[type='checkbox']").forEach(cb => { 
    resultados.push({ marca: cb.dataset.marca, disponible: cb.checked }); 
  });
  
  let popRecopilado = materialesPOP.map((pop, index) => ({ 
    nombre: pop, 
    presente: document.getElementById(`pop-${index}`) ? document.getElementById(`pop-${index}`).checked : false
  }));
  
  let evalVisita = aspectosVisita.map((aspecto, index) => ({ 
    aspecto, 
    cumple: document.getElementById(`visita-${index}`).checked 
  }));
  
  let evalDiaria = []; 
  
  const previas = visitas.filter(v => v.fechaISO === getHoy() && v.vendedor === vendedor);
  if (previas.length === 0) { 
    evalDiaria = aspectosDiarios.map((aspecto, index) => ({ 
      aspecto, 
      cumple: document.getElementById(`diario-${index}`).checked 
    })); 
  } else { 
    evalDiaria = previas[0].evaluacionDiaria; 
  }

  let txtAnalisisFoto = ""; 
  const boxIaFoto = document.getElementById("box-ia-foto"); 
  if(boxIaFoto.style.display === "block") { 
    txtAnalisisFoto = boxIaFoto.innerText; 
  }
  
  // Nuevos campos
  const comproPorGenomma = document.getElementById('compro-genomma')?.checked || false;
  const comproPorDuracell = document.getElementById('compro-duracell')?.checked || false;
  
  const nuevaVisita = { 
    id: Date.now(), 
    fechaISO: getHoy(), 
    hora: new Date().toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}), 
    distribuidor, vendedor, zona, tienda, notas, comentarioGeneral, lat, lng, 
    resultados, pop: popRecopilado, evaluacionDiaria: evalDiaria, 
    evaluacionVisita: evalVisita, fotoMin: fotoMinBase64, analisisVisual: txtAnalisisFoto,
    comproPorGenomma, comproPorDuracell,
    datoDiario: datoDiario ? { ...datoDiario } : null
  };
  
  try {
    if (db) {
      await db.collection("visitas").doc(nuevaVisita.id.toString()).set(nuevaVisita);
    } else {
      visitas.push(nuevaVisita); 
      localStorage.setItem("visitas", JSON.stringify(visitas));
    }
    
    document.getElementById("tienda").value = ""; 
    document.getElementById("notas-visita").value = "";
    const cgEl = document.getElementById("comentario-general-auditoria");
    if (cgEl) cgEl.value = ""; 
    document.querySelectorAll("#marcas-senso input[type='checkbox']").forEach(cb => cb.checked = false); 
    aspectosVisita.forEach((_, i) => document.getElementById(`visita-${i}`).checked = false); 
    materialesPOP.forEach((_, i) => { 
      const el = document.getElementById(`pop-${i}`); 
      if (el) el.checked = false; 
    });
    if (document.getElementById('compro-genomma')) document.getElementById('compro-genomma').checked = false;
    if (document.getElementById('compro-duracell')) document.getElementById('compro-duracell').checked = false;
    
    document.getElementById("foto-preview-container").style.display = "none"; 
    document.getElementById("btn-ia-foto").style.display = "none"; 
    boxIaFoto.style.display = "none"; 
    
    fotoBase64AI = null; 
    fotoMinBase64 = null;
    
    // Limpiar estado guardado del formulario (solo los campos de tienda/notas/checks)
    const stateStr = localStorage.getItem('formState');
    if (stateStr) {
      const state = JSON.parse(stateStr);
      state.tienda = '';
      state.notas = '';
      state.comproPorGenomma = false;
      state.comproPorDuracell = false;
      state.marcasCheck = {};
      state.visitaCheck = {};
      state.popCheck = {};
      localStorage.setItem('formState', JSON.stringify(state));
    }
    
    verificarEvaluacionDiaria(); 
    restaurarBoton(); 
    showToast("Auditoría guardada con éxito");
  } catch(e) {
    alert("Error conectando con la base de datos: " + e.message);
    restaurarBoton();
  }
}

// ==========================================
// 13. IA GOOGLE GEMINI (VISUAL, COACHING Y REPORTE)
// ==========================================
async function analizarFotoIA() {
  if (!geminiApiKey) return alert("Configura tu API Key en Ajustes → Motor IA.");
  if (!fotoBase64AI) return alert("Primero captura una foto.");

  const btn = document.getElementById("btn-ia-foto"); 
  const box = document.getElementById("box-ia-foto");

  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analizando…';
  box.style.display = "block"; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-eye fa-spin"></i> Escaneando exhibición…</span>';

  const base64Data = fotoBase64AI.split(',')[1];

  const distriSeleccionado = document.getElementById("distribuidor")?.value || "";
  const distriObj = distribuidores.find(d => d.nombre === distriSeleccionado);
  const vendeDuracell = distriObj?.marcasAsignadas?.includes('Duracell');
  const marcasContexto = (distriObj?.marcasAsignadas?.length > 0)
    ? distriObj.marcasAsignadas.join(', ')
    : marcas.map(m => typeof m === 'object' ? m.nombre : m).join(', ');

  const duracellTxt = vendeDuracell
    ? `Duracell es parte del portafolio auditado — analiza su exhibición y presencia.`
    : `Duracell NO hace parte del portafolio en este punto.`;

  const tiendaActual = document.getElementById('tienda')?.value || 'punto de venta';
  const zonaActual   = document.getElementById('zona')?.value   || '';
  const competidoresList = 'Advil, Dolex, Advil Gripa, Electrolit, Energizer, Gaviscon, Pantene, Mieltertos';

  const prompt = `Analiza esta foto de un punto de venta TAT (tienda a tienda).
Tienda: ${tiendaActual}${zonaActual ? ` — ${zonaActual}` : ''}.
Portafolio auditado: ${marcasContexto}. ${duracellTxt}

Análisis detallado y específico. Cada sección debe ser sustancial — NO uses respuestas vagas como 'buena presencia' sin dar detalles concretos. Si no ves algo claramente, dilo. Formato directo de campo:

1. PASTILLERO GENOMMA: ¿presente y visible? ¿Frentes que ocupa? ¿Posición (nivel visual, cercanía a la caja)? Califica visibilidad: Alta/Media/Baja.

2. PRESENCIA DE MARCAS (${marcasContexto}): para cada marca detectada indica si está visible, frentes aproximados y posición en lineal o mostrador.

3. PARTICIPACIÓN VS COMPETENCIA: compara espacio y visibilidad del portafolio frente a competidores detectados (solo los que veas: ${competidoresList}). Estima % de participación visual aproximado.

4. HALLAZGO CLAVE: el punto más crítico que impacta las ventas (positivo o negativo).

5. ACCIÓN INMEDIATA: una sola acción concreta que el vendedor debe hacer en este momento.`;

  try {
    const texto = await llamarGemini({ prompt, imageBase64: base64Data, maxRetries: 2, maxTokens: 2000 });
    const textHtml = textoAHtml(texto);
    box.innerHTML = `
      <div style="border-bottom:1px solid #ce93d8; padding-bottom:6px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
        <b style="color:#673AB7;"><i class="fas fa-camera"></i> Análisis Visual IA</b>
        <span style="font-size:0.7rem; color:#888;">${tiendaActual}</span>
      </div>
      <div style="font-size:0.88rem; line-height:1.5; color:#333;">${textHtml}</div>`;
    btn.innerHTML = '<i class="fas fa-redo"></i> Re-analizar';
    btn.disabled = false;
  } catch(e) {
    box.innerHTML = `<div style="background:#f8d7da; color:#721c24; padding:10px; border-radius:8px; font-size:0.85rem;">
      <b><i class="fas fa-exclamation-triangle"></i> Error IA:</b><br>${e.message}
    </div>`;
    btn.innerHTML = '<i class="fas fa-magic"></i> Reintentar';
    btn.disabled = false;
  }
}

async function generarAnalisisIA(nombreVendedor, tiendas, pctMarcas, pctDiaria, pctVisita, indexBoton, popLogros, impGenomma, valGenomma, impDuracell, valDuracell, vendeDuracell) {
  if (!geminiApiKey) return alert("Configura tu API Key en Ajustes → Motor IA.");

  const objVendedor = vendedores.find(v => v.nombre === nombreVendedor); 
  const telefonoUrl = objVendedor?.telefono ? `57${objVendedor.telefono}` : "";

  const getBtnBox = () => ({
    btn: document.getElementById(`btn-ia-${indexBoton}`),
    box: document.getElementById(`box-ia-${indexBoton}`)
  });

  let { btn, box } = getBtnBox();
  if (!btn || !box) return;

  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generando…';
  box.style.display = 'block'; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-magic fa-spin"></i> Analizando resultados…</span>';

  const popTxt = popLogros > 0 ? `✅ Logró POP en ${popLogros} tiendas.` : "⚠️ Sin logros POP hoy.";
  const ventasTxt = `Genomma: ${impGenomma || 0} tiendas compraron ($${Number(valGenomma||0).toLocaleString('es-CO')})`
    + (vendeDuracell ? ` | Duracell: ${impDuracell || 0} tiendas ($${Number(valDuracell||0).toLocaleString('es-CO')})` : '');

  // Datos reales del grupo de visitas del día
  const fechaFiltro = document.getElementById('fecha-filtro')?.value || getHoy();
  const visitasVend = visitas.filter(v => v.vendedor === nombreVendedor && v.fechaISO === fechaFiltro);
  const novedadesVend = visitasVend.map(v => v.notas).filter(n => n?.length > 3).join(' | ') || 'Sin novedades';
  const comentarioAudit = visitasVend[0]?.comentarioGeneral || '';
  const analisisVisualResumen = truncar(visitasVend.filter(v => v.analisisVisual?.length > 10).map(v => v.analisisVisual.replace(/<[^>]*>/g,'')).join(' '), 400);
  const marcasPorTienda = visitasVend.slice(0, 6).map(v => {
    const si = v.resultados?.filter(r => r.disponible).map(r => r.marca).join(',') || '-';
    const no = v.resultados?.filter(r => !r.disponible).map(r => r.marca).join(',') || '';
    return `${v.tienda}(${v.zona||''}): ✓${si}${no?' ✗'+no:''}`;
  }).join(' | ');

  const prompt = `Eres un experto coach de ventas TAT con 15 años en trade marketing de consumo masivo en Colombia. Escribe un WhatsApp de coaching a ${nombreVendedor} que motive Y enseñe técnicas concretas.

DATOS REALES HOY:
- Tiendas: ${tiendas} | Marcas presentes: ${pctMarcas}% | Tácticas venta: ${pctVisita}% | Presentación: ${pctDiaria}%
- Ventas: ${ventasTxt} | POP: ${popTxt}
- Detalle tiendas: ${marcasPorTienda || 'N/D'}
- Novedades campo: ${novedadesVend}
- Comentario gestor: ${comentarioAudit || 'Sin comentario'}
- Análisis visual: ${analisisVisualResumen || 'Sin análisis'}

ESTRUCTURA (mínimo 200 palabras, sé específico y concreto con los datos reales — no genérico):
1. 🙌 SALUDO: por nombre, reconoce UN dato específico del día.
2. 📊 ANÁLISIS HONESTO: si marcas <70% identifica las 2 críticas y en qué tiendas fallaron. Si tácticas <80% di cuál paso falló con un ejemplo real. Si hubo ventas: número exacto y qué lo logró.
3. 🎯 TÉCNICA DEL DÍA (una técnica concreta):
   - Pastillero bajo → técnica de posicionamiento a nivel de caja, primera línea visual
   - Marcas bajas → técnica del "costo de oportunidad" para el tendero
   - Tácticas bajas → diálogo de ejemplo para el paso específico que falló
4. 🔥 RETO MAÑANA: objetivo numérico específico y alcanzable.
5. ✍️ Cesar Pescador – Genomma Lab

Tono: entrenador de alto rendimiento — cercano, directo, exigente pero empático.`;

  try {
    const texto = await llamarGemini({ prompt, maxTokens: 2200 });
    const textHtml = textoAHtml(texto);
    const waText = encodeURIComponent(texto);

    // Re-obtener referencias por si el DOM se refrescó
    const refs = getBtnBox();
    if (!refs.box) return;
    refs.box.innerHTML = `
      <div style="font-size:1rem; margin-bottom:8px; color:#673AB7; border-bottom:1px solid #ce93d8; padding-bottom:5px;">
        <b><i class="fas fa-user-tie"></i> Coaching Genomma Lab:</b>
      </div>
      <div style="color:#333; font-size:0.92rem; margin-bottom:12px; line-height:1.5;">${textHtml}</div>
      <button class="btn-primary" style="background:#25D366; padding:10px; font-size:0.95rem;" onclick="window.open('https://wa.me/${telefonoUrl}?text=${waText}','_blank')">
        <i class="fab fa-whatsapp"></i> Enviar por WhatsApp
      </button>`;
    if (refs.btn) refs.btn.innerHTML = '<i class="fas fa-check"></i> Generado';

  } catch(error) {
    const refs = getBtnBox();
    if (refs.box) refs.box.innerHTML = `<div style="background:#f8d7da; color:#721c24; padding:10px; border-radius:8px; font-size:0.85rem;">
      <b><i class="fas fa-exclamation-triangle"></i> Error IA:</b><br>${error.message}
    </div>`;
    if (refs.btn) { refs.btn.disabled = false; refs.btn.innerHTML = '<i class="fas fa-sync"></i> Reintentar'; }
  }
}

async function generarReporteGerencial() {
  if (!geminiApiKey) return alert("Configura tu API Key en Ajustes → Motor IA.");

  const datos = obtenerDatosFiltrados().principal; 
  if (datos.length === 0) return alert("Sin datos en el período seleccionado.");

  const box = document.getElementById("box-reporte-gerencia"); 
  const btn = document.getElementById("btn-reporte-gerencia");

  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analizando…';
  box.style.display = 'block'; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-cog fa-spin"></i> Consolidando datos…</span>';

  // ── Construir resumen de datos ─────────────────────────────────
  const totalTiendas         = datos.length;
  const vendedoresActivos    = [...new Set(datos.map(v => v.vendedor))].join(", ");
  const distribuidoresAudit  = [...new Set(datos.map(v => v.distribuidor))].join(", ");
  const observaciones        = truncar(datos.map(v => v.notas).filter(n => n?.length > 3).join(". ") || "Sin novedades.", 400);
  const analisisFotos        = truncar(datos.map(v => v.analisisVisual).filter(a => a?.length > 10).join(". ") || "Sin análisis visual.", 350);
  const totalImpGenomma      = datos.filter(v => v.comproPorGenomma).length;
  const totalImpDuracell     = datos.filter(v => v.comproPorDuracell).length;

  let marcaStats = {};
  datos.forEach(v => v.resultados?.forEach(r => {
    if (!marcaStats[r.marca]) marcaStats[r.marca] = { t: 0, c: 0 };
    marcaStats[r.marca].t++;
    if (r.disponible) marcaStats[r.marca].c++;
  }));
  const marcaBajaPresencia = Object.keys(marcaStats)
    .sort((a, b) => (marcaStats[a].c / marcaStats[a].t) - (marcaStats[b].c / marcaStats[b].t))
    .slice(0, 2)
    .map(m => `${m} (${Math.round((marcaStats[m].c / marcaStats[m].t) * 100)}%)`)
    .join(', ') || 'N/D';

  const infoDia        = datos[0]?.datoDiario || datoDiario || {};
  const codigoRuta     = infoDia.codigo || 'N/D';
  const numClientesRuta= infoDia.numClientes || '-';
  const agotadosDia    = infoDia.agotados?.length > 0 ? infoDia.agotados.join(', ') : 'Ninguno';

  // Comentarios generales de auditoría del período
  const comentariosGenerales = truncar(datos.filter(v => v.comentarioGeneral?.length > 3).map(v => `[${v.vendedor}/${v.tienda}]: ${v.comentarioGeneral}`).join(' | ') || 'Sin comentarios generales.', 500);

  // Stats tácticas por vendedor
  const statsVendedores = {};
  datos.forEach(v => {
    if (!statsVendedores[v.vendedor]) statsVendedores[v.vendedor] = { tiendas: 0, impG: 0, tac: 0, tacT: 0, marcasC: 0, marcasT: 0 };
    statsVendedores[v.vendedor].tiendas++;
    if (v.comproPorGenomma) statsVendedores[v.vendedor].impG++;
    v.evaluacionVisita?.forEach(e => { statsVendedores[v.vendedor].tacT++; if(e.cumple) statsVendedores[v.vendedor].tac++; });
    v.resultados?.forEach(r => { statsVendedores[v.vendedor].marcasT++; if(r.disponible) statsVendedores[v.vendedor].marcasC++; });
  });
  const resVendedores = Object.keys(statsVendedores).map(vend => {
    const s = statsVendedores[vend];
    const pctM = s.marcasT ? Math.round(s.marcasC/s.marcasT*100) : 0;
    const pctT = s.tacT ? Math.round(s.tac/s.tacT*100) : 0;
    return `${vend}: ${s.tiendas} tiendas | marcas ${pctM}% | tácticas ${pctT}% | ${s.impG} compras Genomma`;
  }).join(' | ');

  // Marcas con presencia completa por tienda
  const detallesMarcas = Object.keys(marcaStats).map(m => `${m}: ${Math.round(marcaStats[m].c/marcaStats[m].t*100)}%`).join(' | ');

  const prompt = `Eres un experto en gestión de sell-out y trade marketing de consumo masivo en Colombia. Escribe un reporte táctico para el SUPERVISOR de distribuidor —no para gerencia— que necesita información accionable HOY para tomar decisiones de campo.

DATOS COMPLETOS DE LA JORNADA:
Ruta ${codigoRuta} | Clientes en ruta: ${numClientesRuta} | Tiendas auditadas: ${totalTiendas}
Distribuidores: ${distribuidoresAudit} | Vendedores: ${vendedoresActivos}
Impactos de compra: Genomma ${totalImpGenomma} tiendas | Duracell ${totalImpDuracell} tiendas
Agotados en ruta: ${agotadosDia}
Presencia por marca: ${detallesMarcas}
Resultado por vendedor: ${resVendedores}
Novedades de campo: ${observaciones}
Análisis visual de exhibiciones: ${analisisFotos}
Comentarios del gestor (por tienda): ${comentariosGenerales}

ESCRIBE EL REPORTE CON ESTA ESTRUCTURA (mínimo 200 palabras, cada sección con datos específicos — nombres de vendedores, marcas, porcentajes reales del día. NO uses frases genéricas):

🔴 ALERTA INMEDIATA: el hallazgo más crítico que exige acción HOY (agotado, competencia ganando espacio, vendedor con tácticas muy bajas, etc.). Nombra al vendedor o la tienda específica.

📊 RESULTADOS CLAVE: los 3 números más importantes del día con interpretación breve. Señala si hay una brecha grande entre vendedores.

🏪 SITUACIÓN DE MARCAS EN PUNTO DE VENTA: qué marcas están perdiendo espacio, en qué zonas o tiendas, y qué indica el análisis visual sobre competencia.

🎯 PASTILLERO Y POP: estado del material de impulso, si está siendo colocado correctamente o hay faltante.

✅ ACCIÓN CONCRETA PARA EL SUPERVISOR (1 sola, la más impactante): debe ser específica, ejecutable hoy o mañana, con nombre de vendedor o tienda si aplica.`;

  try {
    const texto = await llamarGemini({ prompt, maxTokens: 2400 });
    const textHtml = textoAHtml(texto);
    const waText   = encodeURIComponent(texto);

    // Auto-guardar
    const nuevoInforme = {
      id: Date.now(),
      tipo: 'supervisor',
      fecha: getHoy(),
      horaGuardado: new Date().toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'}),
      texto: textHtml,
      textoPlano: texto
    };
    informesGuardados.push(nuevoInforme);
    localStorage.setItem('informesGuardados', JSON.stringify(informesGuardados));

    box.innerHTML = `
      <div style="font-size:1rem; margin-bottom:8px; color:#673AB7; border-bottom:1px solid #ce93d8; padding-bottom:5px; display:flex; justify-content:space-between;">
        <b><i class="fas fa-user-shield"></i> Reporte Supervisor:</b>
        <span style="font-size:0.7rem; color:#28a745; font-weight:bold;"><i class="fas fa-check-circle"></i> Guardado</span>
      </div>
      <div style="color:#333; font-size:0.88rem; margin-bottom:12px; line-height:1.5;">${textHtml}</div>
      <button class="btn-primary" style="padding:10px; font-size:0.9rem; background:#25D366;" onclick="window.open('https://wa.me/?text=${waText}','_blank')">
        <i class="fab fa-whatsapp"></i> Enviar por WhatsApp
      </button>`;
    btn.innerHTML = '<i class="fas fa-check"></i> Reporte Generado';

  } catch(error) {
    box.innerHTML = `<div style="background:#f8d7da; color:#721c24; padding:12px; border-radius:8px; font-size:0.85rem;">
      <b><i class="fas fa-exclamation-triangle"></i> Error al generar reporte:</b><br>${error.message}
    </div>`;
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-magic"></i> Reintentar';
  }
}

function guardarInformeIA(fecha, btnEl) {
  const box = document.getElementById("box-reporte-gerencia");
  const textHtml = box.dataset.textRaw || box.innerHTML;
  
  const nuevoInforme = {
    id: Date.now(),
    fecha: fecha,
    horaGuardado: new Date().toLocaleTimeString('es-ES', {hour:'2-digit', minute:'2-digit'}),
    texto: textHtml
  };
  
  informesGuardados.push(nuevoInforme);
  localStorage.setItem('informesGuardados', JSON.stringify(informesGuardados));
  
  if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-check"></i> Guardado'; }
  showToast('Informe guardado en historial');
}

// ==========================================
// 14. CALENDARIO E HISTORIAL DE AUDITORÍA
// ==========================================
function cambiarVistaCalendario(vista) {
  document.getElementById('tab-historial').classList.remove('active'); 
  document.getElementById('tab-google').classList.remove('active'); 
  document.getElementById('contenedor-historial').style.display = 'none'; 
  document.getElementById('contenedor-google').style.display = 'none';
  
  if (vista === 'historial') { 
    document.getElementById('tab-historial').classList.add('active'); 
    document.getElementById('contenedor-historial').style.display = 'block'; 
    mostrarRegistrosPorFecha(); 
  } else { 
    document.getElementById('tab-google').classList.add('active'); 
    document.getElementById('contenedor-google').style.display = 'block'; 
    mostrarGoogleCalendar(); 
  }
}

function mostrarGoogleCalendar() {
  const container = document.getElementById("gcal-iframe-container");
  if (!googleCalendarId) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: #888;"><i class="fas fa-exclamation-triangle" style="font-size: 2rem; color:#f39c12; margin-bottom:10px;"></i><br>Configura Google Calendar en Ajustes.</div>`;
    return;
  }
  container.innerHTML = `<iframe src="https://calendar.google.com/calendar/embed?src=${encodeURIComponent(googleCalendarId)}&mode=AGENDA&showTitle=0&showNav=1&showDate=0&showPrint=0&showTabs=0&showCalendars=0&showTz=0" style="border: 0" width="100%" height="400" frameborder="0" scrolling="yes"></iframe>`;
}

function mostrarRegistrosPorFecha() {
  const fechaFiltro = document.getElementById('fecha-filtro').value; 
  const contenedor = document.getElementById("lista-registros"); 
  const visitasDelDia = visitas.filter(v => v.fechaISO === fechaFiltro);
  
  if (visitasDelDia.length === 0) {
    contenedor.innerHTML = `<p style="text-align:center; color:#888; margin-top:20px;">No hay registros en esta fecha.</p>`;
    return;
  }
  
  const grupos = {}; 
  visitasDelDia.forEach(v => { 
    const clave = `${v.distribuidor}|${v.vendedor}`; 
    if(!grupos[clave]) grupos[clave] = []; 
    grupos[clave].push(v); 
  });

  let htmlResult = "";
  Object.keys(grupos).forEach((clave, index) => {
    const grupo = grupos[clave]; 
    const datos = grupo[0]; 
    const horaInicio = grupo[0].hora; 
    const horaFin = grupo[grupo.length - 1].hora;
    
    const zonasUnicas = [...new Set(grupo.map(v => v.zona))].join(", ");
    
    let tMarcas = 0, cMarcas = 0; 
    let tVisitas = 0, cVisitas = 0; 
    let countPop = 0;
    let countComproGenomma = 0;
    let countComproDuracell = 0;
    
    grupo.forEach(v => { 
      v.resultados.forEach(r => { tMarcas++; if(r.disponible) cMarcas++; }); 
      if(v.evaluacionVisita) v.evaluacionVisita.forEach(e => { tVisitas++; if(e.cumple) cVisitas++; }); 
      if(v.pop) v.pop.forEach(p => { if(p.presente) countPop++; });
      if(v.comproPorGenomma) countComproGenomma++;
      if(v.comproPorDuracell) countComproDuracell++;
    });
    
    let tDiaria = datos.evaluacionDiaria ? datos.evaluacionDiaria.length : 0; 
    let cDiaria = datos.evaluacionDiaria ? datos.evaluacionDiaria.filter(e => e.cumple).length : 0;
    
    const pctMarcas = tMarcas ? Math.round((cMarcas/tMarcas)*100) : 0; 
    const pctDiaria = tDiaria ? Math.round((cDiaria/tDiaria)*100) : 0; 
    const pctVisita = tVisitas ? Math.round((cVisitas/tVisitas)*100) : 0;

    // Obtener si este distribuidor vende Duracell
    const distriObj = distribuidores.find(d => d.nombre === datos.distribuidor);
    const vendeDuracell = distriObj && distriObj.marcasAsignadas && distriObj.marcasAsignadas.includes('Duracell');
    
    // Recuperar datos editables guardados
    const claveEdit = `${fechaFiltro}|${datos.distribuidor}|${datos.vendedor}`;
    const editData = datosHistorialEdit[claveEdit] || {};
    const impGenomma = editData.impactosGenomma !== undefined ? editData.impactosGenomma : countComproGenomma;
    const valGenomma = editData.valorGenomma !== undefined ? editData.valorGenomma : 0;
    const impDuracell = editData.impactosDuracell !== undefined ? editData.impactosDuracell : countComproDuracell;
    const valDuracell = editData.valorDuracell !== undefined ? editData.valorDuracell : 0;
    
    // Datos de ruta
    const infDia = datos.datoDiario || datoDiario || {};
    const numClientesRuta = infDia.numClientes || grupo.length;
    const codigoRuta = infDia.codigo || '-';

    const duracellEditHtml = vendeDuracell ? `
      <div style="background:#e8f5e9; border-radius:8px; padding:10px; margin-bottom:8px;">
        <b style="color:#1D6F42; font-size:0.85rem;"><i class="fas fa-battery-full"></i> Duracell</b>
        <div style="display:flex; gap:8px; margin-top:5px;">
          <div style="flex:1;">
            <label style="font-size:0.75rem; color:#666; margin-bottom:3px; display:block;">Impactos</label>
            <input type="number" id="edit-imp-duracell-${index}" value="${impDuracell}" style="width:100%; padding:6px; border-radius:6px; border:1px solid #ccc; font-size:0.9rem;" min="0">
          </div>
          <div style="flex:1;">
            <label style="font-size:0.75rem; color:#666; margin-bottom:3px; display:block;">Valor $</label>
            <input type="number" id="edit-val-duracell-${index}" value="${valDuracell}" style="width:100%; padding:6px; border-radius:6px; border:1px solid #ccc; font-size:0.9rem;" min="0">
          </div>
        </div>
      </div>` : '';

    // Google Calendar link para la sesión completa
    const gcalTitulo = `Acompañamiento ${datos.vendedor} — ${datos.distribuidor}`;
    const gcalDetalle = `Ruta: ${codigoRuta} | ${numClientesRuta} clientes | ${grupo.length} tiendas auditadas | Marcas: ${pctMarcas}% | Tácticas: ${pctVisita}% | Imp. Genomma: ${impGenomma}`;
    const gcalLink = generarEnlaceCalendario(gcalTitulo, gcalDetalle, fechaFiltro, horaInicio, horaFin);

    htmlResult += `
      <div class="sesion-card">
        <div class="sesion-header" onclick="toggleDetalles(${index})">
          <h4><i class="fas fa-route"></i> ${datos.vendedor}</h4>
          <p><i class="fas fa-map-marker-alt"></i> Zonas: ${zonasUnicas}</p>
          <p><i class="fas fa-truck"></i> Dist: ${datos.distribuidor}</p>
          <p><i class="fas fa-road"></i> Ruta: ${codigoRuta} | Clientes: ${numClientesRuta}</p>
          <p><i class="fas fa-clock"></i> ${horaInicio} - ${horaFin}</p>
          <span class="badge-stats">Tiendas Auditadas: ${grupo.length}</span>
          <i class="fas fa-chevron-down toggle-icon" id="icon-${index}"></i>
        </div>
        <div class="sesion-detalles" id="detalles-${index}">
          <!-- Botón Google Calendar para la sesión -->
          <a href="${gcalLink}" target="_blank" style="display:flex; align-items:center; gap:8px; background:#4285F4; color:white; padding:10px 14px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:0.85rem; margin-bottom:12px; justify-content:center;">
            <i class="fas fa-calendar-plus"></i> Registrar en Google Calendar
          </a>
          <div class="resumen-ruta">
            <h5>📊 Resumen Laboral</h5>
            <div class="stat-line"><span>Marcas Genomma Lab:</span> <strong>${pctMarcas}%</strong></div>
            <div class="stat-line"><span>Presentación (1ra visita):</span> <strong>${pctDiaria}%</strong></div>
            <div class="stat-line"><span>Guion de Visita (Tácticas):</span> <strong style="color:var(--eval);">${pctVisita}%</strong></div>
            <div class="stat-line"><span><i class="fas fa-pills"></i> Impactos Genomma:</span> <strong style="color:var(--primary);">${impGenomma}</strong></div>
            ${vendeDuracell ? `<div class="stat-line" style="border:none;"><span><i class="fas fa-battery-full"></i> Impactos Duracell:</span> <strong style="color:#1D6F42;">${impDuracell}</strong></div>` : ''}
          </div>
          
          <!-- CAMPOS EDITABLES GENOMMA / DURACELL -->
          <div style="background:#f9f9f9; border:1px solid #ddd; border-radius:10px; padding:12px; margin-bottom:12px;">
            <h5 style="color:var(--primary); margin-bottom:10px;"><i class="fas fa-edit"></i> Datos de Venta (Editable)</h5>
            
            <div style="background:#e8f0fe; border-radius:8px; padding:10px; margin-bottom:8px;">
              <b style="color:var(--primary); font-size:0.85rem;"><i class="fas fa-pills"></i> Genomma Lab</b>
              <div style="display:flex; gap:8px; margin-top:5px;">
                <div style="flex:1;">
                  <label style="font-size:0.75rem; color:#666; margin-bottom:3px; display:block;">Impactos</label>
                  <input type="number" id="edit-imp-genomma-${index}" value="${impGenomma}" style="width:100%; padding:6px; border-radius:6px; border:1px solid #ccc; font-size:0.9rem;" min="0">
                </div>
                <div style="flex:1;">
                  <label style="font-size:0.75rem; color:#666; margin-bottom:3px; display:block;">Valor Venta $</label>
                  <input type="number" id="edit-val-genomma-${index}" value="${valGenomma}" style="width:100%; padding:6px; border-radius:6px; border:1px solid #ccc; font-size:0.9rem;" min="0">
                </div>
              </div>
            </div>
            
            ${duracellEditHtml}
            
            <button onclick="guardarEditHistorial('${claveEdit}', ${index}, ${vendeDuracell})" 
              class="btn-primary" style="padding:8px; font-size:0.85rem; background:#28a745; margin-top:5px;">
              <i class="fas fa-save"></i> Guardar Datos
            </button>
          </div>
          
          <div style="display:flex; gap:10px; margin-bottom:15px;">
            <button id="btn-ia-${index}" class="btn-primary" style="flex:1; background:#673AB7; padding:10px; font-size:0.9rem;" onclick="generarAnalisisIA('${datos.vendedor}', ${grupo.length}, ${pctMarcas}, ${pctDiaria}, ${pctVisita}, ${index}, ${countPop}, ${impGenomma}, ${valGenomma}, ${impDuracell}, ${valDuracell}, ${vendeDuracell})"><i class="fas fa-magic"></i> Feedback de Coaching</button>
          </div>
          <div id="box-ia-${index}" class="ai-report-box" style="display:none;"></div>
          
          ${grupo.map(reg => {
            const resumenMarcas = reg.resultados.map(r => `<span class="${r.disponible ? 'badge-green' : 'badge-red'}">${r.disponible ? '✔' : '✖'} ${r.marca}</span>`).join(' | ');
            const resumenPop = reg.pop && reg.pop.filter(p=>p.presente).length > 0 ? `<div style="font-size:0.8rem; color:#17a2b8; font-weight:bold; margin-top:3px;"><i class="fas fa-box-open"></i> POP: ` + reg.pop.filter(p=>p.presente).map(p=>p.nombre).join(', ') + `</div>` : ``;
            let cumplidosVisita = reg.evaluacionVisita ? reg.evaluacionVisita.filter(c => c.cumple).length : 0; 
            let totalVisita = reg.evaluacionVisita ? reg.evaluacionVisita.length : 0;
            let btnMapa = reg.lat ? `<a href="https://www.google.com/maps/search/?api=1&query=${reg.lat},${reg.lng}" target="_blank" class="link-mapa"><i class="fas fa-map-marker-alt"></i> Mapa</a>` : ``;
            let txtNotas = reg.notas ? `<div style="font-size:0.8rem; background:#fff3cd; padding:5px; border-radius:5px; margin-top:5px;"><i class="fas fa-comment-dots"></i> ${reg.notas}</div>` : '';
            let txtComentarioGeneral = reg.comentarioGeneral ? `<div style="font-size:0.82rem; background:#f3e5f5; padding:6px 8px; border-radius:5px; margin-top:5px; border-left:3px solid #673AB7; color:#4a148c;"><i class="fas fa-comment-alt"></i> <b>Comentario:</b> ${reg.comentarioGeneral}</div>` : '';
            let fotoHTML = reg.fotoMin ? `<div style="margin-top:8px;"><img src="${reg.fotoMin}" style="width:50px; border-radius:5px; border:1px solid #ccc;"></div>` : '';
            let iaVisualHTML = '';
            if (reg.analisisVisual && reg.analisisVisual.length > 10) {
              const iaId = `ia-text-${reg.id}`;
              iaVisualHTML = `
                <div style="margin-top:6px;">
                  <button onclick="toggleDirElement('${iaId}','icon-${iaId}')" style="background:#e8eaf6; border:none; border-radius:6px; padding:5px 10px; font-size:0.75rem; color:#4a148c; cursor:pointer; display:flex; align-items:center; gap:6px; width:100%;">
                    ${reg.fotoMin ? `<img src="${reg.fotoMin}" style="width:30px; height:30px; border-radius:4px; object-fit:cover; flex-shrink:0;">` : ''}
                    <span><i class="fas fa-robot" style="margin-right:3px;"></i> Análisis IA Visual</span>
                    <i class="fas fa-chevron-down" id="icon-${iaId}" style="margin-left:auto; font-size:0.75rem;"></i>
                  </button>
                  <div id="${iaId}" style="display:none; background:#f3e5f5; border-radius:0 0 6px 6px; padding:8px; font-size:0.78rem; color:#4a148c; line-height:1.5; border:1px solid #ce93d8; border-top:none;">
                    ${reg.analisisVisual.replace(/\n/g,'<br>')}
                    ${reg.fotoMin ? `<div style="margin-top:8px;"><img src="${reg.fotoMin}" style="max-width:100%; border-radius:6px; border:1px solid #ccc;"></div>` : ''}
                  </div>
                </div>`;
            } else if (reg.fotoMin) {
              iaVisualHTML = `<div style="margin-top:8px;"><img src="${reg.fotoMin}" style="width:50px; border-radius:5px; border:1px solid #ccc;"></div>`;
            }
            let comprasBadge = '';
            if (reg.comproPorGenomma) comprasBadge += `<span style="background:#e8f0fe; color:var(--primary); padding:2px 6px; border-radius:10px; font-size:0.75rem; margin-right:4px;"><i class="fas fa-pills"></i> Genomma</span>`;
            if (reg.comproPorDuracell) comprasBadge += `<span style="background:#e8f5e9; color:#1D6F42; padding:2px 6px; border-radius:10px; font-size:0.75rem;"><i class="fas fa-battery-full"></i> Duracell</span>`;
            
            return `
            <div class="registro-card">
              <div style="font-weight:bold; margin-bottom:3px;"><i class="fas fa-store"></i> ${reg.tienda} <span style="font-weight:normal; font-size:0.75rem; color:#888;">(${reg.zona})</span> ${btnMapa}</div>
              <div style="font-size:0.8rem; color:#666; margin-bottom:5px;">Hora: ${reg.hora}</div>
              <div style="font-size:0.85rem; margin-bottom:5px;">${resumenMarcas}</div>
              ${resumenPop}
              <div style="font-size:0.8rem; color:var(--eval); font-weight:bold; margin-top:5px;"><i class="fas fa-star"></i> Tácticas: ${cumplidosVisita}/${totalVisita}</div>
              ${comprasBadge ? `<div style="margin-top:5px;">${comprasBadge}</div>` : ''}
              ${txtNotas}
              ${txtComentarioGeneral}
              ${iaVisualHTML}
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  });
  
  contenedor.innerHTML = htmlResult;
}

function guardarEditHistorial(claveEdit, index, vendeDuracell) {
  const impGenomma = parseFloat(document.getElementById(`edit-imp-genomma-${index}`)?.value || 0);
  const valGenomma = parseFloat(document.getElementById(`edit-val-genomma-${index}`)?.value || 0);
  
  datosHistorialEdit[claveEdit] = {
    impactosGenomma: impGenomma,
    valorGenomma: valGenomma
  };
  
  if (vendeDuracell) {
    const impDuracell = parseFloat(document.getElementById(`edit-imp-duracell-${index}`)?.value || 0);
    const valDuracell = parseFloat(document.getElementById(`edit-val-duracell-${index}`)?.value || 0);
    datosHistorialEdit[claveEdit].impactosDuracell = impDuracell;
    datosHistorialEdit[claveEdit].valorDuracell = valDuracell;
  }
  
  localStorage.setItem('datosHistorialEdit', JSON.stringify(datosHistorialEdit));
  showToast('Datos de venta guardados');
}

function toggleDetalles(index) { 
  const det = document.getElementById(`detalles-${index}`); 
  const ico = document.getElementById(`icon-${index}`); 
  det.classList.toggle("show"); 
  ico.classList.toggle("fa-chevron-up"); 
  ico.classList.toggle("fa-chevron-down"); 
}

function exportarExcel() {
  // El CSV se exporta desde el Historial, usando su propio filtro de fecha (fecha-filtro)
  const fechaFiltro = document.getElementById('fecha-filtro')?.value;
  
  // Determinar qué datos exportar: si hay fecha en el historial, usar esa fecha;
  // si no, exportar todos los registros disponibles
  let datosExport;
  if (fechaFiltro) {
    datosExport = visitas.filter(v => v.fechaISO === fechaFiltro);
  } else {
    datosExport = [...visitas];
  }

  if (datosExport.length === 0) {
    return alert(`No hay registros para la fecha ${fechaFiltro || 'seleccionada'}.\n\nVerifica que la fecha del Historial coincida con las auditorías guardadas.`);
  }

  // Obtener impactos/valores editados del historial para incluirlos en el reporte
  const obtenerEditData = (v) => {
    const clave = `${v.fechaISO}|${v.distribuidor}|${v.vendedor}`;
    return datosHistorialEdit[clave] || {};
  };

  // ── Encabezados ──────────────────────────────────────────────────────
  const encabezados = [
    // Identificación
    "Fecha", "Hora", "ID_Visita",
    // Ruta
    "Ruta_Codigo", "Ruta_Clientes", "Ruta_Agotados",
    // Actores
    "Distribuidor", "Vendedor", "Zona", "Tienda",
    // Ventas e impactos (editables desde historial)
    "Impactos_Genomma", "Valor_Venta_Genomma",
    "Impactos_Duracell", "Valor_Venta_Duracell",
    "Impactos_Total", "Valor_Total",
    // Compras en visita
    "Compro_Genomma_Visita", "Compro_Duracell_Visita",
    // GPS
    "Latitud", "Longitud", "Link_Mapa",
    // Novedades
    "Notas_Competencia",
    "Comentario_General_Auditoria",
    // Análisis IA
    "IA_Visual_Exhibicion",
  ];

  // Marcas dinámicas
  const nombresMarcas = marcas.map(m => typeof m === 'object' ? m.nombre : m);
  nombresMarcas.forEach(m => encabezados.push(`Marca_${m.replace(/\s/g,'_')}`));

  // POP
  materialesPOP.forEach(p => encabezados.push(`POP_${p.replace(/\s/g,'_')}`));

  // Evaluación diaria
  aspectosDiarios.forEach((a, i) => encabezados.push(`Diaria_${i+1}_${a.substring(0,30).replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]/g,'').trim()}`));

  // Evaluación de visita (tácticas)
  aspectosVisita.forEach((a, i) => encabezados.push(`Tactica_${i+1}_${a.substring(0,30).replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]/g,'').trim()}`));

  // ── Construir filas ───────────────────────────────────────────────────
  const esc = (val) => `"${String(val || '').replace(/"/g, '""')}"`;

  let csvContent = "\uFEFF" + encabezados.join(";") + "\r\n";

  datosExport.forEach(v => {
    const edit = obtenerEditData(v);
    const infDia = v.datoDiario || {};

    // Impactos y valores (prioridad: editado > contado automáticamente)
    const distriObj = distribuidores.find(d => d.nombre === v.distribuidor);
    const vendeDuracell = distriObj?.marcasAsignadas?.includes('Duracell');
    const impG = edit.impactosGenomma !== undefined ? edit.impactosGenomma : (v.comproPorGenomma ? 1 : 0);
    const valG = edit.valorGenomma   !== undefined ? edit.valorGenomma   : 0;
    const impD = vendeDuracell ? (edit.impactosDuracell !== undefined ? edit.impactosDuracell : (v.comproPorDuracell ? 1 : 0)) : 0;
    const valD = vendeDuracell ? (edit.valorDuracell    !== undefined ? edit.valorDuracell    : 0) : 0;

    const txtIA = v.analisisVisual
      ? v.analisisVisual.replace(/<[^>]*>?/gm, '').replace(/(\r\n|\n|\r)/gm, ' ').substring(0, 500)
      : 'Sin análisis';

    const linkMapa = (v.lat && v.lat !== 'Sin datos')
      ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}`
      : '';

    const agotados = infDia.agotados ? infDia.agotados.join(' | ') : '';

    let fila = [
      v.fechaISO,
      v.hora || '',
      v.id || '',
      esc(infDia.codigo || ''),
      infDia.numClientes || '',
      esc(agotados),
      esc(v.distribuidor),
      esc(v.vendedor),
      esc(v.zona),
      esc(v.tienda),
      impG, valG,
      impD, valD,
      Number(impG) + Number(impD),
      Number(valG) + Number(valD),
      v.comproPorGenomma  ? 'SI' : 'NO',
      v.comproPorDuracell ? 'SI' : 'NO',
      v.lat || 'Sin GPS',
      v.lng || 'Sin GPS',
      esc(linkMapa),
      esc(v.notas || ''),
      esc(v.comentarioGeneral || ''),
      esc(txtIA),
    ];

    // Marcas
    nombresMarcas.forEach(nombre => {
      const r = v.resultados?.find(x => x.marca === nombre);
      fila.push(r ? (r.disponible ? 'SI' : 'NO') : 'N/A');
    });

    // POP
    materialesPOP.forEach(pop => {
      const p = v.pop?.find(x => x.nombre === pop);
      fila.push(p ? (p.presente ? 'SI' : 'NO') : 'N/A');
    });

    // Evaluación diaria
    aspectosDiarios.forEach(aspecto => {
      const c = v.evaluacionDiaria?.find(x => x.aspecto === aspecto);
      fila.push(c ? (c.cumple ? 'SI' : 'NO') : 'N/A');
    });

    // Tácticas de visita
    aspectosVisita.forEach(aspecto => {
      const c = v.evaluacionVisita?.find(x => x.aspecto === aspecto);
      fila.push(c ? (c.cumple ? 'SI' : 'NO') : 'N/A');
    });

    csvContent += fila.join(";") + "\r\n";
  });

  const fecha = fechaFiltro || getHoy();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }));
  link.download = `Auditoria_GenommaLab_${fecha}.csv`;
  link.click();
  showToast(`CSV exportado: ${datosExport.length} registros`);
}

function exportarTodoElHistorial() {
  if (visitas.length === 0) return alert("No hay auditorías guardadas para exportar.");
  
  // Guardar temporalmente la fecha actual para restaurarla después
  const fechaActual = document.getElementById('fecha-filtro')?.value;
  
  // Exportar todo sin filtro de fecha
  const allDates = [...new Set(visitas.map(v => v.fechaISO))].sort();
  const rangoFechas = allDates.length > 0 
    ? `${allDates[0]}_al_${allDates[allDates.length - 1]}` 
    : getHoy();

  // Reutilizar la lógica de exportarExcel pero con todos los registros
  const esc = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
  const nombresMarcas = marcas.map(m => typeof m === 'object' ? m.nombre : m);

  const encabezados = [
    "Fecha", "Hora", "ID_Visita",
    "Ruta_Codigo", "Ruta_Clientes", "Ruta_Agotados",
    "Distribuidor", "Vendedor", "Zona", "Tienda",
    "Impactos_Genomma", "Valor_Venta_Genomma",
    "Impactos_Duracell", "Valor_Venta_Duracell",
    "Impactos_Total", "Valor_Total",
    "Compro_Genomma_Visita", "Compro_Duracell_Visita",
    "Latitud", "Longitud", "Link_Mapa",
    "Notas_Competencia", "Comentario_General_Auditoria", "IA_Visual_Exhibicion",
  ];
  nombresMarcas.forEach(m => encabezados.push(`Marca_${m.replace(/\s/g,'_')}`));
  materialesPOP.forEach(p => encabezados.push(`POP_${p.replace(/\s/g,'_')}`));
  aspectosDiarios.forEach((a, i) => encabezados.push(`Diaria_${i+1}`));
  aspectosVisita.forEach((a, i) => encabezados.push(`Tactica_${i+1}`));

  let csvContent = "\uFEFF" + encabezados.join(";") + "\r\n";

  // Ordenar por fecha descendente
  const visitasOrdenadas = [...visitas].sort((a, b) => b.fechaISO.localeCompare(a.fechaISO));

  visitasOrdenadas.forEach(v => {
    const clave = `${v.fechaISO}|${v.distribuidor}|${v.vendedor}`;
    const edit = datosHistorialEdit[clave] || {};
    const infDia = v.datoDiario || {};
    const distriObj = distribuidores.find(d => d.nombre === v.distribuidor);
    const vendeDuracell = distriObj?.marcasAsignadas?.includes('Duracell');
    const impG = edit.impactosGenomma !== undefined ? edit.impactosGenomma : (v.comproPorGenomma ? 1 : 0);
    const valG = edit.valorGenomma   !== undefined ? edit.valorGenomma   : 0;
    const impD = vendeDuracell ? (edit.impactosDuracell !== undefined ? edit.impactosDuracell : (v.comproPorDuracell ? 1 : 0)) : 0;
    const valD = vendeDuracell ? (edit.valorDuracell !== undefined ? edit.valorDuracell : 0) : 0;
    const txtIA = v.analisisVisual ? v.analisisVisual.replace(/<[^>]*>?/gm,'').replace(/(\r\n|\n|\r)/gm,' ').substring(0,500) : '';
    const linkMapa = (v.lat && v.lat !== 'Sin datos') ? `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}` : '';

    let fila = [
      v.fechaISO, v.hora || '', v.id || '',
      esc(infDia.codigo || ''), infDia.numClientes || '', esc((infDia.agotados || []).join(' | ')),
      esc(v.distribuidor), esc(v.vendedor), esc(v.zona), esc(v.tienda),
      impG, valG, impD, valD, Number(impG)+Number(impD), Number(valG)+Number(valD),
      v.comproPorGenomma ? 'SI':'NO', v.comproPorDuracell ? 'SI':'NO',
      v.lat || 'Sin GPS', v.lng || 'Sin GPS', esc(linkMapa),
      esc(v.notas || ''), esc(v.comentarioGeneral || ''), esc(txtIA),
    ];
    nombresMarcas.forEach(nombre => {
      const r = v.resultados?.find(x => x.marca === nombre);
      fila.push(r ? (r.disponible ? 'SI':'NO') : 'N/A');
    });
    materialesPOP.forEach(pop => {
      const p = v.pop?.find(x => x.nombre === pop);
      fila.push(p ? (p.presente ? 'SI':'NO') : 'N/A');
    });
    aspectosDiarios.forEach(aspecto => {
      const c = v.evaluacionDiaria?.find(x => x.aspecto === aspecto);
      fila.push(c ? (c.cumple ? 'SI':'NO') : 'N/A');
    });
    aspectosVisita.forEach(aspecto => {
      const c = v.evaluacionVisita?.find(x => x.aspecto === aspecto);
      fila.push(c ? (c.cumple ? 'SI':'NO') : 'N/A');
    });
    csvContent += fila.join(";") + "\r\n";
  });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }));
  link.download = `Historial_Completo_GenommaLab_${rangoFechas}.csv`;
  link.click();
  showToast(`Historial completo exportado: ${visitasOrdenadas.length} registros de ${allDates.length} días`);
}
function cambiarVistaStats(vista) {
  document.getElementById('tab-stat-clasico').classList.remove('active'); 
  document.getElementById('tab-stat-dash').classList.remove('active'); 
  document.getElementById('tab-stat-powerbi').classList.remove('active'); 
  
  document.getElementById('stats-clasico').style.display = 'none'; 
  document.getElementById('stats-dashboard').style.display = 'none'; 
  document.getElementById('stats-powerbi').style.display = 'none';
  
  if (vista === 'clasico') { 
    document.getElementById('tab-stat-clasico').classList.add('active'); 
    document.getElementById('stats-clasico').style.display = 'block'; 
  } else if (vista === 'powerbi') { 
    document.getElementById('tab-stat-powerbi').classList.add('active'); 
    document.getElementById('stats-powerbi').style.display = 'block'; 
  } else { 
    document.getElementById('tab-stat-dash').classList.add('active'); 
    document.getElementById('stats-dashboard').style.display = 'block'; 
    actualizarEstadisticas(); 
  }
}

function cambiarFiltroStats() {
  const tipo = document.getElementById("tipo-filtro-stats").value; 
  document.getElementById("filtro-stat-dia").style.display = tipo === 'hoy' ? 'block' : 'none'; 
  document.getElementById("filtro-stat-mes").style.display = tipo === 'mes' ? 'block' : 'none'; 
  document.getElementById("filtro-stat-inicio").style.display = tipo === 'rango' ? 'block' : 'none'; 
  document.getElementById("filtro-stat-fin").style.display = tipo === 'rango' ? 'block' : 'none'; 
  actualizarEstadisticas();
}

function obtenerDatosFiltrados() {
  const tipo = document.getElementById("tipo-filtro-stats").value; 
  let arrayPrincipal = []; 
  let arrayAnterior = [];
  
  if (tipo === 'hoy') { 
    const dia = document.getElementById("filtro-stat-dia").value; 
    arrayPrincipal = visitas.filter(v => v.fechaISO === dia); 
    let d = new Date(dia); 
    d.setDate(d.getDate() - 1); 
    arrayAnterior = visitas.filter(v => v.fechaISO === d.toISOString().split('T')[0]); 
  } 
  else if (tipo === 'mes') { 
    const mesVal = document.getElementById("filtro-stat-mes").value; 
    arrayPrincipal = visitas.filter(v => v.fechaISO.startsWith(mesVal)); 
    let d = new Date(mesVal + "-01"); 
    d.setMonth(d.getMonth() - 1); 
    arrayAnterior = visitas.filter(v => v.fechaISO.startsWith(d.toISOString().substring(0, 7))); 
  }
  else if (tipo === 'rango') { 
    const ini = document.getElementById("filtro-stat-inicio").value; 
    const fin = document.getElementById("filtro-stat-fin").value; 
    arrayPrincipal = visitas.filter(v => v.fechaISO >= ini && v.fechaISO <= fin); 
  }
  else if (tipo === 'ytd') { 
    const anio = new Date().getFullYear().toString(); 
    arrayPrincipal = visitas.filter(v => v.fechaISO.startsWith(anio)); 
    arrayAnterior = visitas.filter(v => v.fechaISO.startsWith((new Date().getFullYear() - 1).toString())); 
  } 
  return { principal: arrayPrincipal, anterior: arrayAnterior };
}

function calcularTasa(array) { 
  if(array.length === 0) return { tacticas: 0 }; 
  let tVisitas = 0, cVisitas = 0; 
  array.forEach(v => { 
    if(v.evaluacionVisita) {
      v.evaluacionVisita.forEach(e => { tVisitas++; if(e.cumple) cVisitas++; }); 
    }
  }); 
  return { tacticas: tVisitas ? Math.round((cVisitas/tVisitas)*100) : 0 }; 
}

function mostrarTendencia(idElemento, valorActual, valorAnterior, mostrar) { 
  const el = document.getElementById(idElemento); 
  if (!mostrar || valorAnterior === 0) { el.innerHTML = ""; el.className = "trend-badge"; return; } 
  
  const dif = valorActual - valorAnterior; 
  
  if (dif > 0) { 
    el.innerHTML = `<i class="fas fa-arrow-up"></i> +${dif}`; 
    el.className = "trend-badge trend-up"; 
  } else if (dif < 0) { 
    el.innerHTML = `<i class="fas fa-arrow-down"></i> ${dif}`; 
    el.className = "trend-badge trend-down"; 
  } else { 
    el.innerHTML = `<i class="fas fa-minus"></i> 0`; 
    el.className = "trend-badge trend-neutral"; 
  } 
}

function actualizarEstadisticas() {
  const datos = obtenerDatosFiltrados(); 
  const vMain = datos.principal; 
  const vPrev = datos.anterior; 
  const tipoFiltro = document.getElementById("tipo-filtro-stats").value; 
  const muestraTendencia = (tipoFiltro === 'mes' || tipoFiltro === 'hoy' || tipoFiltro === 'ytd');
  
  document.getElementById("btn-reporte-gerencia").disabled = false; 
  document.getElementById("btn-reporte-gerencia").innerHTML = '<i class="fas fa-magic"></i> Generar Resumen con IA'; 
  document.getElementById("box-reporte-gerencia").style.display = 'none';
  if (document.getElementById("box-informe-operativo")) document.getElementById("box-informe-operativo").style.display = 'none';
  
  document.getElementById("kpi-tiendas").innerText = vMain.length; 
  mostrarTendencia("trend-tiendas", vMain.length, vPrev.length, muestraTendencia); 
  
  const tasaActual = calcularTasa(vMain).tacticas; 
  const tasaAnterior = calcularTasa(vPrev).tacticas; 
  document.getElementById("kpi-tacticas").innerText = tasaActual + "%"; 
  mostrarTendencia("trend-tacticas", tasaActual, tasaAnterior, muestraTendencia);
  
  // KPI adicional Genomma impactos
  const totalImpGenomma = vMain.filter(v => v.comproPorGenomma).length;
  const prevImpGenomma = vPrev.filter(v => v.comproPorGenomma).length;
  const elKpiGenomma = document.getElementById("kpi-genomma-imp");
  if (elKpiGenomma) { elKpiGenomma.innerText = totalImpGenomma; }
  const trendGenommaEl = document.getElementById("trend-genomma-imp");
  if (trendGenommaEl) mostrarTendencia("trend-genomma-imp", totalImpGenomma, prevImpGenomma, muestraTendencia);
  
  // KPI Duracell impactos
  const totalImpDuracell = vMain.filter(v => v.comproPorDuracell).length;
  const prevImpDuracell = vPrev.filter(v => v.comproPorDuracell).length;
  const elKpiDuracell = document.getElementById("kpi-duracell-imp");
  if (elKpiDuracell) { elKpiDuracell.innerText = totalImpDuracell; }
  if (document.getElementById("trend-duracell-imp")) mostrarTendencia("trend-duracell-imp", totalImpDuracell, prevImpDuracell, muestraTendencia);

  let dataMarcas = []; 
  let labelsMarcas = []; 
  
  marcas.forEach(m => { 
    // marcas es ahora un array de strings
    const nombreMarca = (typeof m === 'object') ? m.nombre : m;
    let count = 0, evaluadas = 0; 
    vMain.forEach(v => { 
      const r = v.resultados.find(x => x.marca === nombreMarca); 
      if(r) { evaluadas++; if(r.disponible) count++; } 
    }); 
    if(evaluadas > 0){ 
      labelsMarcas.push(nombreMarca); 
      dataMarcas.push(Math.round((count / evaluadas) * 100)); 
    }
  });
  
  const lblsTacticas = ["Saludo", "Soluciones", "Reconoce Marcas", "Apertura", "Despedida"]; 
  let dataTacticas = []; 
  
  aspectosVisita.forEach(aspecto => { 
    let count = 0; 
    vMain.forEach(v => { 
      if(v.evaluacionVisita) { 
        const c = v.evaluacionVisita.find(x => x.aspecto === aspecto); 
        if(c && c.cumple) count++; 
      } 
    }); 
    dataTacticas.push(vMain.length ? Math.round((count / vMain.length) * 100) : 0); 
  });
  
  let vendedoresUnicos = []; 
  let vPrimeras = []; 
  
  vMain.forEach(v => { 
    if(!vendedoresUnicos.includes(v.vendedor)) { 
      vendedoresUnicos.push(v.vendedor); 
      vPrimeras.push(v); 
    } 
  }); 
  
  let dataDiaria = []; 
  aspectosDiarios.forEach(aspecto => { 
    let count = 0; 
    vPrimeras.forEach(v => { 
      if(v.evaluacionDiaria) { 
        const c = v.evaluacionDiaria.find(x => x.aspecto === aspecto); 
        if(c && c.cumple) count++; 
      } 
    }); 
    dataDiaria.push(vPrimeras.length ? Math.round((count / vPrimeras.length) * 100) : 0); 
  });

  let clsHtml = `<p><strong>Periodo analizado:</strong> ${vMain.length} tiendas</p>`;
  
  // Datos de impactos de compra
  const impGenommaTotal = vMain.filter(v => v.comproPorGenomma).length;
  const impDuracellTotal = vMain.filter(v => v.comproPorDuracell).length;
  clsHtml += `<div style="background:#e8f0fe; border-radius:8px; padding:10px; margin:10px 0;">
    <b style="color:var(--primary);"><i class="fas fa-shopping-cart"></i> Impactos de Compra:</b>
    <div style="display:flex; gap:10px; margin-top:5px;">
      <span style="background:white; padding:5px 10px; border-radius:20px; font-size:0.85rem;"><i class="fas fa-pills" style="color:var(--primary);"></i> Genomma: <b>${impGenommaTotal}</b></span>
      <span style="background:white; padding:5px 10px; border-radius:20px; font-size:0.85rem;"><i class="fas fa-battery-full" style="color:#1D6F42;"></i> Duracell: <b>${impDuracellTotal}</b></span>
    </div>
  </div>`;
  
  clsHtml += `<h4 style="margin:15px 0 10px; color:var(--primary);">Marcas Genomma Lab:</h4>`; 
  labelsMarcas.forEach((m, i) => { clsHtml += generarBarra(m, dataMarcas[i], 'var(--primary)'); }); 
  
  clsHtml += `<h4 style="margin:20px 0 10px; color:var(--primary);">Presentación Diaria (${vendedoresUnicos.length} Vendedores):</h4>`; 
  aspectosDiarios.forEach((a, i) => { clsHtml += generarBarra(a, dataDiaria[i], 'var(--primary)'); }); 
  
  clsHtml += `<h4 style="margin:20px 0 10px; color:var(--eval);">Tácticas (Guion de Visita):</h4>`; 
  aspectosVisita.forEach((a, i) => { clsHtml += generarBarra(a, dataTacticas[i], 'var(--eval)'); }); 
  
  document.getElementById("stats-container").innerHTML = clsHtml;
  
  if (charInstanciaMarcas) charInstanciaMarcas.destroy(); 
  if (charInstanciaTacticas) charInstanciaTacticas.destroy(); 
  if (charInstanciaDiaria) charInstanciaDiaria.destroy();
  
  charInstanciaMarcas = new Chart(document.getElementById('chartMarcas').getContext('2d'), { 
    type: 'bar', 
    data: { labels: labelsMarcas, datasets:[{ label: '% Presencia', data: dataMarcas, backgroundColor: '#0066cc', borderRadius: 4 }] }, 
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { max: 100 } }, plugins: { legend: { display: false } } } 
  });
  
  charInstanciaTacticas = new Chart(document.getElementById('chartTacticas').getContext('2d'), { 
    type: 'radar', 
    data: { labels: lblsTacticas, datasets:[{ label: '% Cumplimiento', data: dataTacticas, backgroundColor: 'rgba(230, 126, 34, 0.2)', borderColor: '#e67e22', pointBackgroundColor: '#e67e22', }] }, 
    options: { responsive: true, maintainAspectRatio: false, scales: { r: { max: 100, min: 0, ticks: { display: false } } }, plugins: { legend: { display: false } } } 
  });
  
  charInstanciaDiaria = new Chart(document.getElementById('chartDiaria').getContext('2d'), { 
    type: 'doughnut', 
    data: { labels: ["Uniforme", "Herramientas"], datasets: [{ data: dataDiaria, backgroundColor:['#28a745', '#17a2b8'], hoverOffset: 4 }] }, 
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } } 
  });
}

function generarBarra(etiqueta, porcentaje, color) { 
  return `<div style="margin-bottom:10px;"><div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>${etiqueta}</span><strong>${porcentaje}%</strong></div><div style="width:100%; background:#e0e0e0; border-radius:5px; height:8px;"><div style="width:${porcentaje}%; background:${color}; height:100%; border-radius:5px;"></div></div></div>`; 
}

// ==========================================
// 17. HUB DE DISTRIBUIDORES
// ==========================================

// Estado vista tareas: 'este' | 'todas'
let _vistaListaTareas = 'este';
// Estado sub-tab tareas: 'pendientes' | 'completadas'
let _estadoTareas = 'pendientes';

function inicializarHubDistrib() {
  const sel = document.getElementById('distrib-select');
  if (!sel) return;
  let opts = '';
  distribuidores.forEach(d => { opts += `<option value="${d.nombre}">${d.nombre}</option>`; });
  sel.innerHTML = opts;
  renderizarHubDistrib();
}

function cambiarTabDistrib(tab) {
  ['stats','tareas'].forEach(t => {
    document.getElementById(`tab-distrib-${t}`)?.classList.remove('active');
    const panel = document.getElementById(`panel-distrib-${t}`);
    if (panel) panel.style.display = 'none';
  });
  document.getElementById(`tab-distrib-${tab}`)?.classList.add('active');
  const panel = document.getElementById(`panel-distrib-${tab}`);
  if (panel) panel.style.display = 'block';
  renderizarHubDistrib();
}

function cambiarPeriodoDistrib(periodo) {
  _periodoDistrib = periodo;
  ['semana','mes','anio'].forEach(p => {
    document.getElementById(`tab-ds-${p}`)?.classList.remove('active');
  });
  document.getElementById(`tab-ds-${periodo}`)?.classList.add('active');
  renderizarStatsDistrib();
}

function cambiarVistaListaTareas(vista) {
  _vistaListaTareas = vista;
  ['este','todas'].forEach(v => document.getElementById(`tab-tareas-${v}`)?.classList.toggle('active', v === vista));
  renderizarTareasDistrib();
}

function cambiarEstadoTareas(estado) {
  _estadoTareas = estado;
  ['pendientes','completadas'].forEach(e => document.getElementById(`tab-estado-${e}`)?.classList.toggle('active', e === estado));
  renderizarTareasDistrib();
}

function renderizarHubDistrib() {
  const panelStats  = document.querySelector('#panel-distrib-stats');
  const panelTareas = document.querySelector('#panel-distrib-tareas');
  if (panelStats  && panelStats.style.display  !== 'none') renderizarStatsDistrib();
  if (panelTareas && panelTareas.style.display !== 'none') renderizarTareasDistrib();
}

function getDistribSeleccionado() {
  return document.getElementById('distrib-select')?.value || '';
}

function getFiltroFechasDistrib() {
  const hoy = new Date();
  const hoyStr = getHoy();
  if (_periodoDistrib === 'semana') {
    const lunesOffset = hoy.getDay() === 0 ? -6 : 1 - hoy.getDay();
    const lunes = new Date(hoy); lunes.setDate(hoy.getDate() + lunesOffset);
    const lunStr = lunes.toISOString().split('T')[0];
    return v => v.fechaISO >= lunStr && v.fechaISO <= hoyStr;
  } else if (_periodoDistrib === 'mes') {
    const mes = hoyStr.substring(0, 7);
    return v => v.fechaISO.startsWith(mes);
  } else {
    const anio = hoyStr.substring(0, 4);
    return v => v.fechaISO.startsWith(anio);
  }
}

function renderizarStatsDistrib() {
  const nombre = getDistribSeleccionado();
  if (!nombre) return;
  const filtroFecha = getFiltroFechasDistrib();
  const visitasDistrib = visitas.filter(v => v.distribuidor === nombre && filtroFecha(v));

  const container = document.getElementById('distrib-stats-content');
  if (!container) return;

  if (visitasDistrib.length === 0) {
    container.innerHTML = `<div class="card" style="text-align:center; color:#888; padding:30px;">
      <i class="fas fa-chart-bar" style="font-size:2rem; opacity:0.3; margin-bottom:10px;"></i>
      <p>Sin acompañamientos registrados en este período</p></div>`;
    return;
  }

  const sesiones = {};
  visitasDistrib.forEach(v => {
    const k = `${v.fechaISO}|${v.vendedor}`;
    if (!sesiones[k]) sesiones[k] = [];
    sesiones[k].push(v);
  });
  const numAcomp = Object.keys(sesiones).length;
  const vendedoresUnicos = [...new Set(visitasDistrib.map(v => v.vendedor))];
  const tiendas = visitasDistrib.length;

  let impGenomma = 0, impDuracell = 0, valGenomma = 0, valDuracell = 0;
  Object.keys(sesiones).forEach(k => {
    const parts = k.split('|');
    const fecha = parts[0], vendedor = parts[1];
    const claveEdit = `${fecha}|${nombre}|${vendedor}`;
    const edit = datosHistorialEdit[claveEdit] || {};
    const grupo = sesiones[k];
    impGenomma += edit.impactosGenomma !== undefined ? edit.impactosGenomma : grupo.filter(v=>v.comproPorGenomma).length;
    impDuracell += edit.impactosDuracell !== undefined ? edit.impactosDuracell : grupo.filter(v=>v.comproPorDuracell).length;
    valGenomma += parseFloat(edit.valorGenomma || 0);
    valDuracell += parseFloat(edit.valorDuracell || 0);
  });

  let marcaData = {};
  visitasDistrib.forEach(v => {
    if (v.resultados) v.resultados.forEach(r => {
      if (!marcaData[r.marca]) marcaData[r.marca] = {t:0,c:0};
      marcaData[r.marca].t++;
      if (r.disponible) marcaData[r.marca].c++;
    });
  });

  let tTac = 0, cTac = 0;
  visitasDistrib.forEach(v => {
    if (v.evaluacionVisita) v.evaluacionVisita.forEach(e => { tTac++; if(e.cumple) cTac++; });
  });
  const pctTac = tTac ? Math.round((cTac/tTac)*100) : 0;

  const distriObj = distribuidores.find(d => d.nombre === nombre);
  const vendeDuracell = distriObj?.marcasAsignadas?.includes('Duracell');
  const labelPeriodo = _periodoDistrib === 'semana' ? 'esta semana' : _periodoDistrib === 'mes' ? 'este mes' : 'este año';

  let html = `
    <div class="card" style="background:linear-gradient(135deg,#0066cc,#004499); color:white; border-radius:12px; padding:15px; margin-bottom:10px;">
      <h4 style="margin:0 0 5px; opacity:0.8; font-size:0.85rem; font-weight:normal;"><i class="fas fa-truck"></i> ${nombre} — ${labelPeriodo}</h4>
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; margin-top:10px;">
        <div style="text-align:center; background:rgba(255,255,255,0.15); border-radius:8px; padding:8px;">
          <div style="font-size:1.5rem; font-weight:bold;">${numAcomp}</div>
          <div style="font-size:0.65rem; opacity:0.8;">Acompañamientos</div>
        </div>
        <div style="text-align:center; background:rgba(255,255,255,0.15); border-radius:8px; padding:8px;">
          <div style="font-size:1.5rem; font-weight:bold;">${vendedoresUnicos.length}</div>
          <div style="font-size:0.65rem; opacity:0.8;">Vendedores</div>
        </div>
        <div style="text-align:center; background:rgba(255,255,255,0.15); border-radius:8px; padding:8px;">
          <div style="font-size:1.5rem; font-weight:bold;">${tiendas}</div>
          <div style="font-size:0.65rem; opacity:0.8;">Tiendas</div>
        </div>
      </div>
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:10px;">
      <div class="kpi-card" style="border-left-color:var(--primary);">
        <i class="fas fa-pills kpi-icon" style="color:var(--primary);"></i>
        <div class="kpi-num" style="font-size:1.3rem;">${impGenomma}</div>
        <div class="kpi-label">Impactos Genomma</div>
        <div style="font-size:0.75rem; color:var(--success); font-weight:bold; margin-top:3px;">$${Number(valGenomma).toLocaleString('es-CO')}</div>
      </div>
      ${vendeDuracell ? `<div class="kpi-card" style="border-left-color:#1D6F42;">
        <i class="fas fa-battery-full kpi-icon" style="color:#1D6F42;"></i>
        <div class="kpi-num" style="font-size:1.3rem;">${impDuracell}</div>
        <div class="kpi-label">Impactos Duracell</div>
        <div style="font-size:0.75rem; color:#1D6F42; font-weight:bold; margin-top:3px;">$${Number(valDuracell).toLocaleString('es-CO')}</div>
      </div>` : `<div class="kpi-card" style="border-left-color:var(--eval);">
        <i class="fas fa-bullseye kpi-icon" style="color:var(--eval);"></i>
        <div class="kpi-num" style="font-size:1.3rem;">${pctTac}%</div>
        <div class="kpi-label">Efectividad Tácticas</div>
      </div>`}
    </div>
    <div class="card">
      <h5 style="color:var(--primary); margin-bottom:10px;"><i class="fas fa-tags"></i> Presencia por Marca</h5>
      ${Object.keys(marcaData).map(m => {
        const pct = marcaData[m].t ? Math.round((marcaData[m].c/marcaData[m].t)*100) : 0;
        const color = pct >= 70 ? '#28a745' : pct >= 40 ? '#e67e22' : '#dc3545';
        return `<div style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:3px;">
            <span>${m}</span><strong style="color:${color};">${pct}%</strong>
          </div>
          <div style="background:#e0e0e0; border-radius:4px; height:6px;">
            <div style="width:${pct}%; background:${color}; height:100%; border-radius:4px;"></div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <h5 style="color:var(--primary); margin-bottom:10px;"><i class="fas fa-calendar-alt"></i> Últimos Acompañamientos</h5>
      ${Object.keys(sesiones).sort().reverse().slice(0,5).map(k => {
        const [fecha, vendedor] = k.split('|');
        const claveEdit = `${fecha}|${nombre}|${vendedor}`;
        const edit = datosHistorialEdit[claveEdit] || {};
        const grupo = sesiones[k];
        const imp = (edit.impactosGenomma || grupo.filter(v=>v.comproPorGenomma).length);
        return `<div class="ficha-stat">
          <span><i class="fas fa-user-tie" style="color:var(--primary); margin-right:5px;"></i>${vendedor}</span>
          <span style="font-size:0.75rem; color:#888;">${fecha} · ${grupo.length} tiendas · ${imp} imp.</span>
        </div>`;
      }).join('')}
    </div>`;

  container.innerHTML = html;
}

// ─── TAREAS ───────────────────────────────────────────────
function abrirModalTarea() {
  const modal = document.getElementById('modal-tarea');
  if (!modal) return;

  // Poblar select de distribuidores en el modal
  const sel = document.getElementById('tarea-distribuidor');
  if (sel) {
    sel.innerHTML = distribuidores.map(d => `<option value="${d.nombre}">${d.nombre}</option>`).join('');
    // Pre-seleccionar el distribuidor activo
    const actual = getDistribSeleccionado();
    if (actual) sel.value = actual;
  }

  document.getElementById('tarea-descripcion').value = '';
  document.getElementById('tarea-fecha').value = getHoy();
  document.getElementById('tarea-hora').value = '09:00';
  modal.style.display = 'flex';
}

function guardarTareaDistrib() {
  const nombre = document.getElementById('tarea-distribuidor')?.value || getDistribSeleccionado();
  const desc   = document.getElementById('tarea-descripcion')?.value.trim();
  const cat    = document.getElementById('tarea-categoria')?.value;
  const fecha  = document.getElementById('tarea-fecha')?.value;
  const hora   = document.getElementById('tarea-hora')?.value || '09:00';

  if (!desc)  return alert('La descripción es obligatoria.');
  if (!fecha) return alert('La fecha límite es obligatoria.');

  if (!tareasDistrib[nombre]) tareasDistrib[nombre] = [];
  const nuevaTarea = { id: Date.now(), distribuidor: nombre, descripcion: desc, categoria: cat, fecha, hora, hecha: false, fechaCompletada: null, creada: getHoy() };
  tareasDistrib[nombre].push(nuevaTarea);
  localStorage.setItem('tareasDistrib', JSON.stringify(tareasDistrib));

  document.getElementById('modal-tarea').style.display = 'none';
  renderizarTareasDistrib();
  showToast(`Tarea agregada para ${nombre}`);
}

function toggleTareaDistrib(nombre, id) {
  if (!tareasDistrib[nombre]) return;
  const t = tareasDistrib[nombre].find(t => t.id === id);
  if (!t) return;
  t.hecha = !t.hecha;
  t.fechaCompletada = t.hecha ? getHoy() : null;
  localStorage.setItem('tareasDistrib', JSON.stringify(tareasDistrib));
  renderizarTareasDistrib();
}

function eliminarTareaDistrib(nombre, id) {
  if (!confirm('¿Eliminar esta tarea permanentemente?')) return;
  if (!tareasDistrib[nombre]) return;
  tareasDistrib[nombre] = tareasDistrib[nombre].filter(t => t.id !== id);
  localStorage.setItem('tareasDistrib', JSON.stringify(tareasDistrib));
  renderizarTareasDistrib();
  showToast('Tarea eliminada');
}

function renderizarTareasDistrib() {
  const container = document.getElementById('lista-tareas-distrib');
  if (!container) return;

  const catColors = { seguimiento:'#0066cc', incentivo:'#e67e22', capacitacion:'#17a2b8', comercial:'#28a745', admin:'#6c757d' };
  const catIcons  = { seguimiento:'fa-eye', incentivo:'fa-trophy', capacitacion:'fa-graduation-cap', comercial:'fa-handshake', admin:'fa-file-alt' };

  // Recopilar tareas según vista
  let todasLasTareas = [];
  if (_vistaListaTareas === 'todas') {
    Object.keys(tareasDistrib).forEach(distrib => {
      (tareasDistrib[distrib] || []).forEach(t => {
        todasLasTareas.push({ ...t, distribuidor: distrib });
      });
    });
  } else {
    const nombre = getDistribSeleccionado();
    todasLasTareas = (tareasDistrib[nombre] || []).map(t => ({ ...t, distribuidor: nombre }));
  }

  // Filtrar por estado
  const filtradas = todasLasTareas.filter(t => _estadoTareas === 'pendientes' ? !t.hecha : t.hecha);

  // Actualizar badges
  const totalPend = todasLasTareas.filter(t => !t.hecha).length;
  const totalComp = todasLasTareas.filter(t => t.hecha).length;
  const badgePend = document.getElementById('badge-pendientes');
  const badgeComp = document.getElementById('badge-completadas');
  if (badgePend) badgePend.textContent = totalPend || '';
  if (badgeComp) badgeComp.textContent = totalComp || '';

  if (filtradas.length === 0) {
    const msg = _estadoTareas === 'pendientes'
      ? 'Sin tareas pendientes. <br>¡Agrega la primera con el botón +!'
      : 'Aún no hay tareas completadas.';
    container.innerHTML = `<div class="card" style="text-align:center; color:#888; padding:25px;">${msg}</div>`;
    return;
  }

  // Ordenar: pendientes por fecha asc, completadas por fecha completada desc
  filtradas.sort((a, b) => {
    if (_estadoTareas === 'pendientes') return (a.fecha || '') > (b.fecha || '') ? 1 : -1;
    return (b.fechaCompletada || '') > (a.fechaCompletada || '') ? 1 : -1;
  });

  // Agrupar por distribuidor si vista = todas
  const grupos = {};
  filtradas.forEach(t => {
    if (!grupos[t.distribuidor]) grupos[t.distribuidor] = [];
    grupos[t.distribuidor].push(t);
  });

  let html = '';
  Object.keys(grupos).forEach(distrib => {
    // Header de grupo solo si es vista "todas"
    if (_vistaListaTareas === 'todas') {
      html += `<div style="font-size:0.75rem; font-weight:bold; color:var(--primary); margin:12px 0 6px; padding-left:4px;">
        <i class="fas fa-truck"></i> ${distrib}
      </div>`;
    }

    grupos[distrib].forEach(t => {
      const color   = catColors[t.categoria] || '#666';
      const icon    = catIcons[t.categoria]  || 'fa-check';
      const vencida = !t.hecha && t.fecha < getHoy();
      const gcalLink = generarEnlaceCalendario(
        `[${t.categoria.toUpperCase()}] ${t.descripcion} — ${distrib}`,
        `Tarea asignada a ${distrib}. Categoría: ${t.categoria}.`,
        t.fecha, t.hora || '09:00'
      );

      html += `
        <div style="display:flex; align-items:flex-start; gap:10px; padding:11px 12px;
          background:${t.hecha ? '#f8f9fa' : 'white'}; border-radius:10px; margin-bottom:8px;
          border-left:4px solid ${t.hecha ? '#ccc' : color};
          ${vencida ? 'box-shadow:inset 0 0 0 1px #dc3545;' : 'box-shadow:0 1px 4px rgba(0,0,0,0.07);'}
          opacity:${t.hecha ? '0.75' : '1'};">

          <input type="checkbox" ${t.hecha ? 'checked' : ''}
            onchange="toggleTareaDistrib('${distrib}', ${t.id})"
            style="margin-top:2px; width:19px; height:19px; accent-color:${color}; flex-shrink:0; cursor:pointer;">

          <div style="flex:1; min-width:0;">
            <div style="font-size:0.88rem; font-weight:bold;
              ${t.hecha ? 'text-decoration:line-through; color:#999;' : 'color:#333;'}
              white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${t.descripcion}
            </div>
            <div style="display:flex; gap:5px; margin-top:5px; align-items:center; flex-wrap:wrap;">
              <span style="background:${color}; color:white; padding:1px 7px; border-radius:8px; font-size:0.65rem;">
                <i class="fas ${icon}"></i> ${t.categoria}
              </span>
              <span style="font-size:0.7rem; color:${vencida ? '#dc3545' : '#888'};">
                ${vencida ? '⚠️ ' : ''}${t.hecha ? '✅ ' + (t.fechaCompletada || '') : t.fecha}
              </span>
              ${gcalLink ? `<a href="${gcalLink}" target="_blank"
                style="font-size:0.65rem; background:#4285F4; color:white; padding:1px 7px; border-radius:8px; text-decoration:none;">
                <i class="fas fa-calendar-plus"></i> Agendar
              </a>` : ''}
            </div>
          </div>

          <button onclick="eliminarTareaDistrib('${distrib}', ${t.id})"
            style="background:none; border:none; color:#ddd; cursor:pointer; font-size:1rem; padding:0; flex-shrink:0;"
            title="Eliminar tarea">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>`;
    });
  });

  container.innerHTML = html;
}
// ==========================================
// 18. INICIAR LA APLICACIÓN
// ==========================================
renderizarApp();