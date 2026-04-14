// ==========================================
// 1. ESTADO INICIAL Y ALMACENAMIENTO LOCAL
// ==========================================
let distriRaw = JSON.parse(localStorage.getItem("distribuidores")) || ["Distribuidora Central", "Aliados TAT"];
let distribuidores = distriRaw.map(d => typeof d === 'string' ? { id: Date.now()+Math.random(), nombre: d, ciudad: "", direccion: "", vendedores: "", clientes: "", supervisores: [] } : d);

let vendedores = JSON.parse(localStorage.getItem("vendedoresObj")) || [];

let marcasRaw = JSON.parse(localStorage.getItem("marcas")) || ["Suerox", "Tío Nacho", "Cicatricure", "Xray", "Genoprazol", "Duracell"];
let marcas = marcasRaw.map(m => typeof m === 'string' ? { nombre: m, distribuidor: "Todos" } : m);

let visitas = JSON.parse(localStorage.getItem("visitas")) || [];
let notasGlobales = JSON.parse(localStorage.getItem("notasGlobales")) || [];
let googleCalendarId = localStorage.getItem("gcalId") || "";
let geminiApiKey = localStorage.getItem("geminiKey") || ""; 

const materialesPOP = ["Pastillero Genomma", "Ganchera Pilas Duracell"];
const aspectosDiarios = [ "Buena presentación personal (Uniforme)", "Porta herramientas (Catálogo/Tablet)" ];
const aspectosVisita = [ "1. Saludo e introducción cordial", "2. Posicionamiento (Soluciones icónicas)", "3. Reconocimiento de Marcas", "4. Apertura comercial (Ayuda a ganar más)", "5. Despedida icónica" ];

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
});

let charInstanciaMarcas = null; 
let charInstanciaTacticas = null; 
let charInstanciaDiaria = null;
let fotoBase64AI = null; 
let fotoMinBase64 = null; 
let supervisoresTemp = [];
let voiceRecognition = null; 
let isRecordingGlobal = false;

// BANDERAS DE EDICIÓN RESTAURADAS
let editandoDistribuidorId = null; 
let editandoVendedorId = null;     

// ==========================================
// 2. NAVEGACIÓN Y UTILIDADES
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
  
  document.getElementById('header-title').innerText = title;
  
  // Ocultar Botón Flotante de Voz en ciertas pestañas
  const btnFlotante = document.getElementById('fab-voice');
  if(btnFlotante) {
    btnFlotante.style.display = (tabId === 'view-voice' || tabId.includes('view-form')) ? 'none' : 'flex';
  }
  
  if (tabId === 'view-calendar') mostrarRegistrosPorFecha();
  if (tabId === 'view-stats') actualizarEstadisticas();
  if (tabId === 'view-directorio') { 
    cambiarVistaDir('vendedores'); 
    renderizarDirectorio(); 
  }
  if (tabId === 'view-voice') { 
    document.getElementById("panel-nota-nueva").style.display = "none"; 
    document.getElementById("box-respuesta-asistente").style.display = "none"; 
    renderizarNotasGlobales(); 
  }
  if (tabId === 'view-settings') { 
    document.getElementById('gcal-id').value = googleCalendarId; 
    document.getElementById('gemini-key').value = geminiApiKey; 
  }
  if (tabId === 'view-audit') actualizarDependenciasAudit();
}

function showToast(mensaje) {
  const container = document.getElementById("toast-container"); 
  const toast = document.createElement("div"); 
  toast.className = "toast";
  toast.innerHTML = `<i class="fas fa-check-circle" style="color:#28a745; margin-right:8px;"></i> ${mensaje}`; 
  container.appendChild(toast); 
  setTimeout(() => toast.remove(), 3000);
}

// ==========================================
// 3. FOTOS Y COMPRESIÓN
// ==========================================
function procesarFoto(event) {
  const file = event.target.files[0]; 
  if(!file) return; 
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image(); 
    img.onload = function() {
      fotoBase64AI = comprimirImagen(img, 800, 0.7); 
      fotoMinBase64 = comprimirImagen(img, 150, 0.5); 
      
      document.getElementById("foto-preview").src = fotoBase64AI; 
      document.getElementById("foto-preview-container").style.display = "block";
      document.getElementById("btn-ia-foto").style.display = "block"; 
      document.getElementById("box-ia-foto").style.display = "none";
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
// 4. DICTADO POR VOZ
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
  
  recognition.onstart = function() { btn.classList.add("pulsing"); };
  recognition.onresult = function(event) { 
    area.value += (area.value ? " " : "") + event.results[0][0].transcript + ". "; 
  };
  recognition.onerror = function() { btn.classList.remove("pulsing"); }; 
  recognition.onend = function() { btn.classList.remove("pulsing"); }; 
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
    if(voiceRecognition) voiceRecognition.stop();
    btn.classList.remove("pulsing"); 
    btn.innerHTML = '<i class="fas fa-microphone"></i>'; 
    status.style.display = "none"; 
    isRecordingGlobal = false;
    document.getElementById("panel-nota-nueva").style.display = "block"; 
    document.getElementById("box-respuesta-asistente").style.display = "none";
  } else {
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
// 5. ASISTENTE VIRTUAL RAG Y CALENDARIO
// ==========================================
function formatearBaseDatosIA() {
  const visRes = visitas.slice(-15).map(v => ({ 
    fecha: v.fechaISO, 
    vendedor: v.vendedor, 
    tienda: v.tienda, 
    notas: v.notas 
  }));
  const notRes = notasGlobales.slice(-10).map(n => ({ 
    fecha: n.fechaCreacion, 
    titulo: n.titulo, 
    contenido: n.textoOriginal 
  }));
  return JSON.stringify({ ultimas_visitas: visRes, mis_notas: notRes });
}

function generarEnlaceCalendario(titulo, detalle, fecha, hora) {
  if (!fecha) return "";
  const horaValida = hora ? hora : "09:00";
  const fStr = fecha.replace(/-/g, ''); 
  const hStr = horaValida.replace(/:/g, '') + '00';
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(titulo)}&dates=${fStr}T${hStr}/${fStr}T${hStr}&details=${encodeURIComponent(detalle)}`;
}

async function enviarAlAsistenteIA() {
  const textoOriginal = document.getElementById("texto-nota-central").value.trim();
  const urgente = document.getElementById("urgente-nota").checked;
  const fechaManual = document.getElementById("fecha-recordatorio").value;
  const horaManual = document.getElementById("hora-recordatorio").value;
  
  const btn = document.getElementById("btn-procesar-nota-ia"); 
  const msg = document.getElementById("msg-ia-nota"); 
  const boxResp = document.getElementById("box-respuesta-asistente");

  if (!textoOriginal) return alert("La caja de texto está vacía.");
  
  if (!geminiApiKey) { 
    alert("⚠️ Sin API Key de IA. Se guarda nota de forma manual.");
    return guardarNotaFisica("Nota de Campo", textoOriginal, textoOriginal, urgente, fechaManual, horaManual);
  }

  btn.disabled = true; 
  msg.style.display = "block"; 
  boxResp.style.display = "none";
  msg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> La IA está analizando tu nota...';
  
  const d = new Date(); 
  const fechaHoyTexto = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  const prompt = `Eres el Asistente IA de Cesar Pescador (Gestor Genomma Lab).
  FECHA DE HOY: ${fechaHoyTexto}.
  BASE DE DATOS: ${formatearBaseDatosIA()}

  Texto del usuario: "${textoOriginal}"

  INSTRUCCIONES ESTRICTAS:
  1. Si es PREGUNTA sobre la BD: "accion" es "pregunta".
  2. Si quiere AGENDAR/RECORDAR algo: "accion" es "agendar", deduce "titulo", "resumen", "fecha_agendada" (YYYY-MM-DD) y "hora_agendada" (HH:MM). (Si dice mañana, suma 1 día).
  3. Si es NOTA/COMENTARIO: "accion" es "nota", deduce OBLIGATORIAMENTE un "titulo" (máximo 5 palabras) y un "resumen".

  RESPONDE SÓLO CON ESTE JSON ESTRICTO:
  {
    "accion": "pregunta" o "agendar" o "nota",
    "respuesta": "Tu respuesta si es pregunta. Vacio si no.",
    "titulo": "Titulo corto aqui",
    "resumen": "Resumen aqui",
    "fecha_agendada": "YYYY-MM-DD",
    "hora_agendada": "HH:MM"
  }`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ contents: [{ parts:[{ text: prompt }] }] })
    });
    
    if (!response.ok) throw new Error(`Error de Google (${response.status})`);
    
    const data = await response.json(); 
    let textRaw = data.candidates[0].content.parts[0].text;
    
    const jsonMatch = textRaw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Formato inválido devuelto por IA.");
    
    let iaResult = JSON.parse(jsonMatch[0]);

    if (iaResult.accion === "pregunta") {
      boxResp.innerHTML = `<b><i class="fas fa-robot"></i> Asistente Genomma Lab:</b><br><br>${iaResult.respuesta.replace(/\n/g, '<br>')}`;
      boxResp.style.display = "block"; 
      btn.disabled = false; 
      msg.style.display = "none";
    } 
    else {
      const tituloFinal = (iaResult.titulo && iaResult.titulo.length > 2) ? iaResult.titulo : "Nota de Campo";
      const resumenFinal = iaResult.resumen || textoOriginal;
      
      let htmlFormat = resumenFinal.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\n/g, '<li>$1</li>').replace(/\n/g, '<br>');
      
      let fAg = fechaManual; 
      let hAg = horaManual;
      
      if (iaResult.accion === "agendar") {
         fAg = iaResult.fecha_agendada || fechaManual || fechaHoyTexto;
         hAg = iaResult.hora_agendada || horaManual || "09:00";
      }

      guardarNotaFisica(tituloFinal, textoOriginal, htmlFormat, urgente, fAg, hAg);
      btn.disabled = false; 
      msg.style.display = "none";
    }

  } catch(e) {
    console.error("Error procesando IA:", e);
    guardarNotaFisica("Nota Guardada Manualmente", textoOriginal, textoOriginal, urgente, fechaManual, horaManual);
    btn.disabled = false; 
    msg.style.display = "none"; 
    alert(`Ocurrió un error con la IA. La nota se guardó manual en el historial.`);
  }
}

function guardarNotaFisica(titulo, original, procesado, urgente, fechaRec, horaRec) {
  let recordatorioStr = null;
  if (fechaRec) { 
    recordatorioStr = horaRec ? `${fechaRec} ${horaRec}` : `${fechaRec} 09:00`; 
  }

  const nuevaNota = { 
    id: Date.now(), 
    fechaCreacion: new Date().toLocaleString(), 
    titulo: titulo, 
    textoOriginal: original, 
    textoHtml: procesado, 
    urgente: urgente, 
    recordatorio: recordatorioStr 
  };
  
  notasGlobales.push(nuevaNota); 
  localStorage.setItem("notasGlobales", JSON.stringify(notasGlobales));
  
  document.getElementById("texto-nota-central").value = ""; 
  document.getElementById("urgente-nota").checked = false; 
  document.getElementById("fecha-recordatorio").value = ""; 
  document.getElementById("hora-recordatorio").value = "";
  document.getElementById("panel-nota-nueva").style.display = "none"; 
  
  showToast("¡Nota Guardada!"); 
  renderizarNotasGlobales();
}

function renderizarNotasGlobales() {
  const contenedor = document.getElementById("lista-notas-central");
  if (notasGlobales.length === 0) {
    contenedor.innerHTML = `<p style="text-align:center; color:#888;">No tienes notas guardadas.</p>`;
    return;
  }
  
  const ordenadas = [...notasGlobales].sort((a,b) => (b.urgente - a.urgente) || (b.id - a.id));
  
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

    htmlNotas += `
    <div class="contacto-card ${n.urgente ? 'nota-urgente' : ''}" style="margin-bottom:10px; padding:10px;">
      <div style="font-size:0.75rem; color:#666; margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;">
        <span><i class="fas fa-clock"></i> ${n.fechaCreacion}</span>
        <div style="display:flex; gap:15px;">
          <i class="fab fa-whatsapp" style="color:#25D366; font-size:1.2rem; cursor:pointer;" onclick="window.open('https://wa.me/?text=${encodeURIComponent('*' + n.titulo + '*\\n\\n' + n.textoOriginal)}', '_blank')"></i>
          <i class="fas fa-trash" style="color:red; font-size:1.1rem; cursor:pointer;" onclick="eliminarNotaGlobal(${n.id})"></i>
        </div>
      </div>
      <div style="font-size:1rem; font-weight:bold; color:var(--primary); margin-bottom:5px; cursor:pointer;" onclick="document.getElementById('body-nota-${n.id}').style.display = document.getElementById('body-nota-${n.id}').style.display === 'none' ? 'block' : 'none'">
        ${n.urgente ? '🔥 ' : ''}${n.titulo} <i class="fas fa-caret-down" style="float:right; margin-top:3px;"></i>
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

function eliminarNotaGlobal(id) { 
  if(!confirm("¿Eliminar nota?")) return; 
  notasGlobales = notasGlobales.filter(n => n.id !== id); 
  localStorage.setItem("notasGlobales", JSON.stringify(notasGlobales)); 
  renderizarNotasGlobales(); 
}

// ==========================================
// 6. RENDERIZADO Y CONTROL DE DEPENDENCIAS DE AUDITORÍA
// ==========================================
function renderizarApp() {
  const distriOptions = distribuidores.map(d => `<option value="${d.nombre}">${d.nombre}</option>`).join('');
  
  document.getElementById("distribuidor").innerHTML = distriOptions; 
  document.getElementById("config-vend-distri").innerHTML = distriOptions;
  document.getElementById("config-marca-distri").innerHTML = `<option value="Todos">Todos los distribuidores</option>` + distriOptions;
  
  let htmlDiario = "";
  aspectosDiarios.forEach((aspecto, index) => {
    htmlDiario += `<div class="cuali-item" style="color:var(--primary);"><span>${aspecto}</span><input type="checkbox" id="diario-${index}"></div>`;
  });
  document.getElementById("eval-diaria-container").innerHTML = htmlDiario;
  
  let htmlVisita = "";
  aspectosVisita.forEach((aspecto, index) => {
    htmlVisita += `<div class="cuali-item"><span>${aspecto}</span><input type="checkbox" id="visita-${index}"></div>`;
  });
  document.getElementById("eval-visita-container").innerHTML = htmlVisita;
  
  let htmlPop = "";
  materialesPOP.forEach((pop, index) => {
    htmlPop += `<div class="cuali-item"><span>${pop}</span><input type="checkbox" id="pop-${index}"></div>`;
  });
  document.getElementById("pop-container").innerHTML = htmlPop;
  
  let htmlMarcasConfig = "";
  marcas.forEach((m, i) => {
    htmlMarcasConfig += `
      <div class="item" style="flex-direction:column; align-items:flex-start;">
        <div><b>${m.nombre}</b></div>
        <div style="width:100%; display:flex; justify-content:space-between; margin-top:5px;">
          <span class="badge-stats" style="background:#17a2b8;">${m.distribuidor}</span> 
          <button class="btn-icon delete" onclick="eliminarDato('marcas', ${i})" style="padding:2px 5px; width:auto;"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
  });
  document.getElementById("lista-marcas-config").innerHTML = htmlMarcasConfig;
  
  actualizarDependenciasAudit();
}

function actualizarDependenciasAudit() {
  const distriSeleccionado = document.getElementById("distribuidor").value;
  
  const vendFiltrados = vendedores.filter(v => v.distribuidor === distriSeleccionado);
  if (vendFiltrados.length === 0) {
    document.getElementById("vendedor").innerHTML = `<option value="">Sin vendedores</option>`;
  } else {
    document.getElementById("vendedor").innerHTML = vendFiltrados.map(v => `<option value="${v.nombre}">${v.nombre}</option>`).join('');
  }
  
  const marcasFiltradas = marcas.filter(m => m.distribuidor === "Todos" || m.distribuidor === distriSeleccionado);
  if (marcasFiltradas.length === 0) {
    document.getElementById("marcas-senso").innerHTML = `<p style="color:#888; font-size:0.9rem;">Sin marcas asignadas.</p>`;
  } else {
    let htmlMarcas = "";
    marcasFiltradas.forEach((m, i) => {
      htmlMarcas += `<div class="marca-item"><span>${m.nombre}</span><input type="checkbox" data-marca="${m.nombre}" id="check-marca-${i}"></div>`;
    });
    document.getElementById("marcas-senso").innerHTML = htmlMarcas;
  }
  
  verificarEvaluacionDiaria();
}

function verificarEvaluacionDiaria() {
  const vendedor = document.getElementById("vendedor").value;
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
    const fallas = visitasPasadas[0].evaluacionVisita.filter(e => !e.cumple).map(e => e.aspecto);
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
// 7. MÓDULO CRUD (CREAR, EDITAR, BORRAR)
// ==========================================

// --- APERTURA DE MODALES DE EDICIÓN ---
function abrirModalCrear(tipo) {
  if(tipo === 'vendedor') {
    if(distribuidores.length === 0) return alert("Primero debes crear un distribuidor en la pestaña Ajustes.");
    document.getElementById("config-vend-id").value = ""; 
    document.getElementById("config-vend-nombre").value = ""; 
    document.getElementById("config-vend-doc").value = ""; 
    document.getElementById("config-vend-tel").value = "";
    document.getElementById("config-vend-distri").innerHTML = distribuidores.map(d => `<option value="${d.nombre}">${d.nombre}</option>`).join('');
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
    document.getElementById("titulo-form-dist").innerHTML = `<i class="fas fa-truck"></i> Nueva Empresa`;
    switchTab('view-form-distribuidor', 'Crear Distribuidor');
  }
}

function cargarEdicionDistribuidor(id) {
  const dist = distribuidores.find(d => d.id === id);
  if(!dist) return;

  editandoDistribuidorId = id; 
  document.getElementById("config-dist-id").value = dist.id;
  document.getElementById("config-dist-nombre").value = dist.nombre;
  document.getElementById("config-dist-ciudad").value = dist.ciudad || "";
  document.getElementById("config-dist-direccion").value = dist.direccion || "";
  document.getElementById("config-dist-vendedores").value = dist.vendedores || "";
  document.getElementById("config-dist-clientes").value = dist.clientes || "";
  
  supervisoresTemp = dist.supervisores ? [...dist.supervisores] : [];
  renderSupTemp();
  
  document.getElementById("titulo-form-dist").innerHTML = `<i class="fas fa-edit"></i> Editar Empresa`;
  switchTab('view-form-distribuidor', 'Editar Distribuidor');
  showToast("Modifica los datos y presiona Guardar");
}

function cargarEdicionVendedor(id) {
  const vend = vendedores.find(v => v.id === id);
  if(!vend) return;

  editandoVendedorId = id;
  document.getElementById("config-vend-id").value = vend.id;
  document.getElementById("config-vend-nombre").value = vend.nombre;
  document.getElementById("config-vend-doc").value = vend.documento || "";
  document.getElementById("config-vend-tel").value = vend.telefono;
  
  document.getElementById("config-vend-distri").innerHTML = distribuidores.map(d => `<option value="${d.nombre}" ${d.nombre === vend.distribuidor ? 'selected' : ''}>${d.nombre}</option>`).join('');
  
  document.getElementById("titulo-form-vend").innerHTML = `<i class="fas fa-user-edit"></i> Editar Vendedor`;
  switchTab('view-form-vendedor', 'Editar Vendedor');
  showToast("Modifica los datos y presiona Guardar");
}

// --- GUARDADO DE DISTRIBUIDOR Y VENDEDOR (SOPORTA EDICIÓN) ---
function guardarDistribuidor() { 
  const idEdit = document.getElementById("config-dist-id").value;
  const nom = document.getElementById("config-dist-nombre").value.trim(); 
  const ciu = document.getElementById("config-dist-ciudad").value.trim(); 
  const dir = document.getElementById("config-dist-direccion").value.trim(); 
  const ven = document.getElementById("config-dist-vendedores").value.trim(); 
  const cli = document.getElementById("config-dist-clientes").value.trim();
  
  if (!nom) return alert("El Nombre de la Distribuidora es obligatorio.");

  // Guardado inteligente de supervisor si quedó texto en la caja
  const supNomPendiente = document.getElementById("config-sup-nombre").value.trim(); 
  const supTelPendiente = document.getElementById("config-sup-tel").value.trim();
  if (supNomPendiente && supTelPendiente) {
    supervisoresTemp.push({ nombre: supNomPendiente, telefono: supTelPendiente });
  }

  if (idEdit) {
    // Es Edición
    let dist = distribuidores.find(d => d.id == idEdit);
    if (dist) {
      dist.nombre = nom;
      dist.ciudad = ciu;
      dist.direccion = dir;
      dist.vendedores = ven;
      dist.clientes = cli;
      dist.supervisores = [...supervisoresTemp];
    }
    showToast("Distribuidor Actualizado");
    editandoDistribuidorId = null;
  } else {
    // Es Creación
    const obj = { 
      id: Date.now(), nombre: nom, ciudad: ciu, direccion: dir, 
      vendedores: ven, clientes: cli, supervisores: [...supervisoresTemp] 
    };
    distribuidores.push(obj); 
    showToast("Distribuidor Creado");
  }
  
  localStorage.setItem("distribuidores", JSON.stringify(distribuidores));
  
  // Limpieza
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
  
  // Devolver al directorio
  switchTab('view-directorio', 'Directorio CRM'); 
  cambiarVistaDir('distribuidores');
}

function agregarVendedor() { 
  const idEdit = document.getElementById("config-vend-id").value;
  const distri = document.getElementById("config-vend-distri").value; 
  const nombre = document.getElementById("config-vend-nombre").value.trim(); 
  const doc = document.getElementById("config-vend-doc").value.trim(); 
  const tel = document.getElementById("config-vend-tel").value.trim();
  
  if (!distri || !nombre || !tel) return alert("Empresa, Nombre y Teléfono son obligatorios."); 
  
  if (idEdit) {
    let ven = vendedores.find(v => v.id == idEdit);
    if(ven) {
      ven.distribuidor = distri;
      ven.nombre = nombre;
      ven.documento = doc;
      ven.telefono = tel;
    }
    showToast("Vendedor Actualizado");
    editandoVendedorId = null;
  } else {
    vendedores.push({ id: Date.now(), distribuidor: distri, nombre: nombre, documento: doc, telefono: tel }); 
    showToast("Vendedor Creado"); 
  }
  
  localStorage.setItem("vendedoresObj", JSON.stringify(vendedores));
  
  document.getElementById("config-vend-id").value = "";
  document.getElementById("config-vend-nombre").value = ""; 
  document.getElementById("config-vend-doc").value = ""; 
  document.getElementById("config-vend-tel").value = ""; 
  
  renderizarApp(); 
  switchTab('view-directorio', 'Directorio CRM'); 
  cambiarVistaDir('vendedores');
}

// --- OTROS MÉTODOS CRUD ---
function addSupTemp() { 
  const nom = document.getElementById("config-sup-nombre").value.trim(); 
  const tel = document.getElementById("config-sup-tel").value.trim(); 
  if(!nom || !tel) return alert("Requerido."); 
  supervisoresTemp.push({ nombre: nom, telefono: tel }); 
  document.getElementById("config-sup-nombre").value = ""; 
  document.getElementById("config-sup-tel").value = ""; 
  renderSupTemp(); 
}

function renderSupTemp() { 
  let html = "";
  supervisoresTemp.forEach((s, i) => {
    html += `<div style="font-size:0.85rem; background:#fff; border:1px solid #eee; padding:5px; margin-bottom:3px; display:flex; justify-content:space-between;"><span>${s.nombre} - ${s.telefono}</span><i class="fas fa-times" style="color:red; cursor:pointer;" onclick="supervisoresTemp.splice(${i},1); renderSupTemp();"></i></div>`;
  });
  document.getElementById("lista-sups-temp").innerHTML = html;
}

function agregarMarca() { 
  const input = document.getElementById("nuevaMarca").value.trim(); 
  const distri = document.getElementById("config-marca-distri").value; 
  if (!input) return; 
  marcas.push({ nombre: input, distribuidor: distri }); 
  localStorage.setItem("marcas", JSON.stringify(marcas)); 
  document.getElementById("nuevaMarca").value = ""; 
  showToast("Marca Agregada"); 
  renderizarApp(); 
}

function eliminarDato(tipo, id_o_index) { 
  if(!confirm("¿Eliminar registro de la base de datos local?")) return; 
  
  if(tipo === 'distribuidores') { 
    distribuidores = distribuidores.filter(d => d.id !== id_o_index); 
    localStorage.setItem("distribuidores", JSON.stringify(distribuidores)); 
  }
  else if(tipo === 'vendedores') { 
    vendedores = vendedores.filter(v => v.id !== id_o_index); 
    localStorage.setItem("vendedoresObj", JSON.stringify(vendedores)); 
  }
  else if(tipo === 'marcas') { 
    marcas.splice(id_o_index, 1); 
    localStorage.setItem("marcas", JSON.stringify(marcas)); 
  }
  
  renderizarApp(); 
  if(tipo === 'distribuidores' || tipo === 'vendedores') renderizarDirectorio();
}

function guardarGCal() { 
  let input = document.getElementById("gcal-id").value.trim(); 
  if (input.includes('src="')) { 
    const match = input.match(/src="([^"]+)"/); 
    if (match) { 
      try { const urlObj = new URL(match[1]); input = urlObj.searchParams.get("src") || input; } catch(e){} 
    } 
  } else if (input.startsWith("http")) { 
    try { const urlObj = new URL(input); input = urlObj.searchParams.get("src") || input; } catch(e){} 
  } 
  googleCalendarId = input; 
  localStorage.setItem("gcalId", googleCalendarId); 
  showToast("Calendario Guardado"); 
}

function guardarGemini() { 
  geminiApiKey = document.getElementById("gemini-key").value.trim(); 
  localStorage.setItem("geminiKey", geminiApiKey); 
  showToast("Clave IA Guardada"); 
}

function exportarBackup() { 
  const data = { 
    vendedoresObj: vendedores, marcas: marcas, visitas: visitas, distribuidores: distribuidores, 
    gcalId: googleCalendarId, geminiKey: geminiApiKey, notas: notasGlobales 
  }; 
  const blob = new Blob([JSON.stringify(data)], {type: "application/json"}); 
  const link = document.createElement("a"); 
  link.href = URL.createObjectURL(blob); 
  link.download = `Backup_GenommaLab_${getHoy()}.json`; 
  link.click(); 
}

function importarBackup(event) { 
  const file = event.target.files[0]; 
  if(!file) return; 
  const reader = new FileReader(); 
  reader.onload = function(e) { 
    try { 
      const data = JSON.parse(e.target.result); 
      if(data.visitas) { 
        localStorage.setItem("vendedoresObj", JSON.stringify(data.vendedoresObj || [])); 
        localStorage.setItem("marcas", JSON.stringify(data.marcas || [])); 
        localStorage.setItem("visitas", JSON.stringify(data.visitas || [])); 
        localStorage.setItem("distribuidores", JSON.stringify(data.distribuidores || [])); 
        localStorage.setItem("notasGlobales", JSON.stringify(data.notas || [])); 
        if(data.gcalId) localStorage.setItem("gcalId", data.gcalId); 
        if(data.geminiKey) localStorage.setItem("geminiKey", data.geminiKey); 
        alert("Backup restaurado con éxito. Se recargará la aplicación."); 
        location.reload(); 
      } else { 
        alert("Archivo JSON inválido."); 
      } 
    } catch(err) { 
      alert("Error al leer archivo."); 
    } 
  }; 
  reader.readAsText(file); 
}

// ==========================================
// 8. DIRECTORIO CRM
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
  
  // RENDER VENDEDORES
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

      // Botón de editar solo aplica si es vendedor y tiene ID
      const btnEditar = (c.tipo === 'Vendedor' && c.id) 
        ? `<i class="fas fa-edit" style="color:#6c757d; cursor:pointer; font-size:1.1rem; margin-right:10px;" onclick="cargarEdicionVendedor(${c.id})"></i>` 
        : "";
        
      const btnEliminar = (c.tipo === 'Vendedor' && c.id)
        ? `<i class="fas fa-trash" style="color:var(--danger); cursor:pointer; font-size:1.1rem;" onclick="eliminarDato('vendedores', ${c.id})"></i>`
        : "";

      htmlContactos += `
      <div class="contacto-card">
        <div class="contacto-header" style="justify-content: flex-start; gap: 15px;">
          <div class="avatar" style="background:${colorBadge}">${inicial}</div>
          <div style="flex:1;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
               <h4 style="margin:0;">${c.nombre}</h4>
               <div>${btnEditar}${btnEliminar}</div>
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

  // RENDER DISTRIBUIDORES
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
          <div style="flex:1;" onclick="toggleDirElement('dist-body-${i}', 'icon-dist-${i}')">
             <h4 style="margin:0; color:#673AB7;"><i class="fas fa-truck"></i> ${d.nombre}</h4>
          </div>
          <div style="display:flex; gap:10px; align-items:center;">
             <i class="fas fa-edit" style="color:#6c757d; font-size:1.1rem;" onclick="cargarEdicionDistribuidor(${d.id})"></i>
             <i class="fas fa-trash" style="color:var(--danger); font-size:1.1rem;" onclick="eliminarDato('distribuidores', ${d.id})"></i>
             <i class="fas fa-chevron-down toggle-icon" id="icon-dist-${i}" style="color:#666; position:relative; right:0; top:0;" onclick="toggleDirElement('dist-body-${i}', 'icon-dist-${i}')"></i>
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

function toggleDirElement(bodyId, iconId) {
  const body = document.getElementById(bodyId);
  const icon = document.getElementById(iconId);
  if(body.style.display === 'none') {
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
// 9. GUARDAR VISITA (GPS Y RESULTADOS)
// ==========================================
function guardarVisita() {
  const distribuidor = document.getElementById("distribuidor").value; 
  const vendedor = document.getElementById("vendedor").value; 
  const zona = document.getElementById("zona").value.trim(); 
  const tienda = document.getElementById("tienda").value.trim(); 
  const notas = document.getElementById("notas-visita").value.trim();
  
  if(!distribuidor || !vendedor || !zona || !tienda) return alert("Llena campos obligatorios.");
  
  const btnGuardar = document.getElementById("btn-guardar"); 
  btnGuardar.disabled = true; 
  btnGuardar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Obteniendo GPS...';

  if (!navigator.geolocation) { 
    alert("Sin GPS."); 
    restaurarBoton(); 
    return; 
  }
  
  navigator.geolocation.getCurrentPosition(
    (position) => { 
      ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, position.coords.latitude, position.coords.longitude); 
    }, 
    (error) => { 
      alert("❌ GPS Falló. Asegúrate de dar permisos de ubicación."); 
      restaurarBoton(); 
    }, 
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function restaurarBoton() { 
  const btnGuardar = document.getElementById("btn-guardar"); 
  btnGuardar.disabled = false; 
  btnGuardar.innerHTML = '<i class="fas fa-save"></i> Guardar Registro Definitivo'; 
}

function ejecutarGuardado(distribuidor, vendedor, zona, tienda, notas, lat, lng) {
  let resultados = []; 
  document.querySelectorAll("#marcas-senso input[type='checkbox']").forEach(cb => { 
    resultados.push({ marca: cb.dataset.marca, disponible: cb.checked }); 
  });
  
  let popRecopilado = materialesPOP.map((pop, index) => ({ 
    nombre: pop, 
    presente: document.getElementById(`pop-${index}`).checked 
  }));
  
  let evalVisita = aspectosVisita.map((aspecto, index) => ({ 
    aspecto, 
    cumple: document.getElementById(`visita-${index}`).checked 
  }));
  
  let evalDiaria = []; 
  
  const previas = visitas.filter(v => v.fechaISO === getHoy() && v.vendedor === vendedor);
  if(previas.length === 0) { 
    evalDiaria = aspectosDiarios.map((aspecto, index) => ({ 
      aspecto, 
      cumple: document.getElementById(`diario-${index}`).checked 
    })); 
  } else { 
    evalDiaria = previas[0].evaluacionDiaria; 
  }

  let txtAnalisisFoto = ""; 
  const boxIaFoto = document.getElementById("box-ia-foto"); 
  if(boxIaFoto.style.display === "block") { txtAnalisisFoto = boxIaFoto.innerText; }
  
  const nuevaVisita = { 
    id: Date.now(), 
    fechaISO: getHoy(), 
    hora: new Date().toLocaleTimeString('es-ES', {hour: '2-digit', minute:'2-digit'}), 
    distribuidor, vendedor, zona, tienda, notas, lat, lng, 
    resultados, pop: popRecopilado, evaluacionDiaria: evalDiaria, 
    evaluacionVisita: evalVisita, fotoMin: fotoMinBase64, analisisVisual: txtAnalisisFoto 
  };
  
  visitas.push(nuevaVisita); 
  localStorage.setItem("visitas", JSON.stringify(visitas));
  
  document.getElementById("tienda").value = ""; 
  document.getElementById("notas-visita").value = ""; 
  document.querySelectorAll("#marcas-senso input[type='checkbox']").forEach(cb => cb.checked = false); 
  aspectosVisita.forEach((_, i) => document.getElementById(`visita-${i}`).checked = false); 
  materialesPOP.forEach((_, i) => document.getElementById(`pop-${i}`).checked = false);
  document.getElementById("foto-preview-container").style.display = "none"; 
  document.getElementById("btn-ia-foto").style.display = "none"; 
  boxIaFoto.style.display = "none"; 
  fotoBase64AI = null; 
  fotoMinBase64 = null;
  
  verificarEvaluacionDiaria(); 
  restaurarBoton(); 
  showToast("Auditoría guardada con éxito");
}

// ==========================================
// 10. IA GOOGLE GEMINI (VISUAL, COACHING Y REPORTE)
// ==========================================
async function analizarFotoIA() {
  if(!geminiApiKey) return alert("Configura API Key en Ajustes.");
  const btn = document.getElementById("btn-ia-foto"); 
  const box = document.getElementById("box-ia-foto"); 
  
  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analizando...'; 
  box.style.display = "block"; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-eye"></i> Escaneando foto...</span>';
  
  const base64Data = fotoBase64AI.split(',')[1]; 
  const prompt = "Eres Gestor Sell Out de Genomma Lab. Analiza exhibición: 1. Presencia de Genomma Lab. 2. Posición vs competencia. 3. Dos recomendaciones cortas para mejorar.";
  
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ contents: [{ parts:[ { text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64Data } } ] }] }) 
    });
    
    if(!response.ok) throw new Error("Error HTTP"); 
    const data = await response.json(); 
    
    let textHtml = data.candidates[0].content.parts[0].text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\n/g, '<li>$1</li>').replace(/\n/g, '<br>');
    box.innerHTML = `<b><i class="fas fa-camera"></i> Evaluación Visual:</b><br>${textHtml}`; 
    btn.innerHTML = '<i class="fas fa-check"></i> Foto Analizada';
  } catch(e) { 
    box.innerHTML = `<span style="color:red;">Error IA: ${e.message}</span>`; 
    btn.disabled = false; 
    btn.innerHTML = '<i class="fas fa-magic"></i> Reintentar'; 
  }
}

async function generarAnalisisIA(nombreVendedor, tiendas, pctMarcas, pctDiaria, pctVisita, indexBoton, popLogros) {
  if(!geminiApiKey) return alert("Configura API Key.");
  
  const objVendedor = vendedores.find(v => v.nombre === nombreVendedor); 
  const telefonoUrl = objVendedor && objVendedor.telefono ? `57${objVendedor.telefono}` : "";
  
  const btn = document.getElementById(`btn-ia-${indexBoton}`); 
  const box = document.getElementById(`box-ia-${indexBoton}`); 
  
  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Feedback...'; 
  box.style.display = 'block'; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-magic"></i> Procesando...</span>';

  let popTxt = popLogros > 0 ? `Logró POP en ${popLogros} tiendas, felicítalo.` : "";
  
  const prompt = `Actúa como Cesar Pescador, Gestor Sell Out Genomma Lab. WhatsApp a ${nombreVendedor}, auditaste ${tiendas} tiendas. Meta: ganar concursos. Efectividad marcas: ${pctMarcas}%. Tácticas: ${pctVisita}%. Presentación/Catálogo: ${pctDiaria}%. (Si < 100%, sugiere usar catálogo amablemente). ${popTxt} Estructura: 1. Saludo. 2. Análisis numérico. 3. "GUION GENOMMA LAB": 1.Saludo, 2.Posicionamiento, 3.Reconocimiento, 4.Apertura comercial, 5.Despedida icónica. 4. Plan de 3 pasos. 5. Firma.`;
  
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ contents: [{ parts:[{ text: prompt }] }] }) 
    });
    
    if(!response.ok) throw new Error("Error HTTP"); 
    
    const data = await response.json(); 
    let textRaw = data.candidates[0].content.parts[0].text; 
    let whatsappText = encodeURIComponent(textRaw); 
    let textHtml = textRaw.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\n/g, '<li>$1</li>').replace(/\n/g, '<br>');
    
    box.innerHTML = `<div style="font-size:1.1rem; margin-bottom:10px; color:#673AB7; border-bottom:1px solid #ce93d8; padding-bottom:5px;"><b><i class="fas fa-user-tie"></i> Coaching Genomma Lab:</b></div> <div style="color:#333; font-size:0.95rem; margin-bottom: 15px;">${textHtml}</div><button class="btn-primary" style="background:#25D366; padding:10px; font-size:1rem; border-radius:8px;" onclick="window.open('https://wa.me/${telefonoUrl}?text=${whatsappText}', '_blank')"><i class="fab fa-whatsapp"></i> Enviar WhatsApp</button>`; 
    btn.innerHTML = '<i class="fas fa-check"></i> Generado';
  } catch(error) { 
    box.innerHTML = `<div style="color:red; font-size:0.9rem;"><b>Error:</b> ${error.message}</div>`; 
    btn.disabled = false; 
    btn.innerHTML = '<i class="fas fa-sync"></i> Reintentar'; 
  }
}

async function generarReporteGerencial() {
  if(!geminiApiKey) return alert("Configura API Key."); 
  
  const datos = obtenerDatosFiltrados().principal; 
  if(datos.length === 0) return alert("Sin datos.");
  
  const box = document.getElementById("box-reporte-gerencia"); 
  const btn = document.getElementById("btn-reporte-gerencia"); 
  btn.disabled = true; 
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analizando...'; 
  box.style.display = 'block'; 
  box.innerHTML = '<span style="color:#673AB7;"><i class="fas fa-cog fa-spin"></i> Consolidando...</span>';

  let totalTiendas = datos.length; 
  let vendedoresActivos = [...new Set(datos.map(v => v.vendedor))].join(", "); 
  let observaciones = datos.map(v => v.notas).filter(n => n && n.length > 3).join(". "); 
  if(!observaciones) observaciones = "Sin novedades.";
  
  const prompt = `Actúa como Cesar Pescador, Gestor Sell Out Genomma Lab. Escribe correo formal a la Gerencia. Resume labor auditando ${totalTiendas} tiendas con: ${vendedoresActivos}. Enfoque "Guion de Visita en Tienda". Notas reales: "${observaciones}". Resume esto como "Hallazgos de Mercado". Tono corporativo.`;
  
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ contents: [{ parts:[{ text: prompt }] }] }) 
    });
    
    if(!response.ok) throw new Error("Error HTTP"); 
    
    const data = await response.json(); 
    let textHtml = data.candidates[0].content.parts[0].text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*(.*?)\n/g, '<li>$1</li>').replace(/\n/g, '<br>');
    box.innerHTML = `<div style="font-size:1.1rem; margin-bottom:10px; color:#673AB7; border-bottom:1px solid #ce93d8; padding-bottom:5px;"><b><i class="fas fa-envelope"></i> Borrador Correo:</b></div> <div style="color:#333; font-size:0.95rem;">${textHtml}</div>`; 
    btn.innerHTML = '<i class="fas fa-check"></i> Reporte Generado';
  } catch(error) { 
    box.innerHTML = `<div style="color:red;"><b>Error:</b> ${error.message}</div>`; 
    btn.disabled = false; 
    btn.innerHTML = '<i class="fas fa-magic"></i> Reintentar Reporte'; 
  }
}

// ==========================================
// 11. CALENDARIO E HISTORIAL DE AUDITORÍA
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
  
  if(visitasDelDia.length === 0) {
    contenedor.innerHTML = `<p style="text-align:center; color:#888; margin-top:20px;">No hay registros en esta fecha.</p>`;
    return;
  }
  
  const grupos = {}; 
  visitasDelDia.forEach(v => { 
    const clave = `${v.distribuidor}|${v.vendedor}|${v.zona}`; 
    if(!grupos[clave]) grupos[clave] = []; 
    grupos[clave].push(v); 
  });

  let htmlResult = "";
  Object.keys(grupos).forEach((clave, index) => {
    const grupo = grupos[clave]; 
    const datos = grupo[0]; 
    const horaInicio = grupo[0].hora; 
    const horaFin = grupo[grupo.length - 1].hora;
    
    let tMarcas = 0, cMarcas = 0; 
    let tVisitas = 0, cVisitas = 0; 
    let countPop = 0;
    
    grupo.forEach(v => { 
      v.resultados.forEach(r => { tMarcas++; if(r.disponible) cMarcas++; }); 
      if(v.evaluacionVisita) v.evaluacionVisita.forEach(e => { tVisitas++; if(e.cumple) cVisitas++; }); 
      if(v.pop) v.pop.forEach(p => { if(p.presente) countPop++; }); 
    });
    
    let tDiaria = datos.evaluacionDiaria ? datos.evaluacionDiaria.length : 0; 
    let cDiaria = datos.evaluacionDiaria ? datos.evaluacionDiaria.filter(e => e.cumple).length : 0;
    
    const pctMarcas = tMarcas ? Math.round((cMarcas/tMarcas)*100) : 0; 
    const pctDiaria = tDiaria ? Math.round((cDiaria/tDiaria)*100) : 0; 
    const pctVisita = tVisitas ? Math.round((cVisitas/tVisitas)*100) : 0;

    htmlResult += `
      <div class="sesion-card">
        <div class="sesion-header" onclick="toggleDetalles(${index})">
          <h4><i class="fas fa-route"></i> ${datos.vendedor} - ${datos.zona}</h4>
          <p><i class="fas fa-truck"></i> Dist: ${datos.distribuidor}</p>
          <p><i class="fas fa-clock"></i> ${horaInicio} - ${horaFin}</p>
          <span class="badge-stats">Tiendas Auditadas: ${grupo.length}</span>
          <i class="fas fa-chevron-down toggle-icon" id="icon-${index}"></i>
        </div>
        <div class="sesion-detalles" id="detalles-${index}">
          <div class="resumen-ruta">
            <h5>📊 Resumen Laboral</h5>
            <div class="stat-line"><span>Marcas Genomma Lab:</span> <strong>${pctMarcas}%</strong></div>
            <div class="stat-line"><span>Presentación (1ra visita):</span> <strong>${pctDiaria}%</strong></div>
            <div class="stat-line" style="border:none;"><span>Guion de Visita (Tácticas):</span> <strong style="color:var(--eval);">${pctVisita}%</strong></div>
          </div>
          
          <div style="display:flex; gap:10px; margin-bottom:15px;">
            <button id="btn-ia-${index}" class="btn-primary" style="flex:1; background:#673AB7; padding:10px; font-size:0.9rem;" onclick="generarAnalisisIA('${datos.vendedor}', ${grupo.length}, ${pctMarcas}, ${pctDiaria}, ${pctVisita}, ${index}, ${countPop})"><i class="fas fa-magic"></i> Feedback de Coaching</button>
          </div>
          <div id="box-ia-${index}" class="ai-report-box" style="display:none;"></div>
          
          ${grupo.map(reg => {
            const resumenMarcas = reg.resultados.map(r => `<span class="${r.disponible ? 'badge-green' : 'badge-red'}">${r.disponible ? '✔' : '✖'} ${r.marca}</span>`).join(' | ');
            const resumenPop = reg.pop && reg.pop.filter(p=>p.presente).length > 0 ? `<div style="font-size:0.8rem; color:#17a2b8; font-weight:bold; margin-top:3px;"><i class="fas fa-box-open"></i> POP: ` + reg.pop.filter(p=>p.presente).map(p=>p.nombre).join(', ') + `</div>` : ``;
            let cumplidosVisita = reg.evaluacionVisita ? reg.evaluacionVisita.filter(c => c.cumple).length : 0; 
            let totalVisita = reg.evaluacionVisita ? reg.evaluacionVisita.length : 0;
            let btnMapa = reg.lat ? `<a href="https://www.google.com/maps/search/?api=1&query=${reg.lat},${reg.lng}" target="_blank" class="link-mapa"><i class="fas fa-map-marker-alt"></i> Mapa</a>` : ``;
            let txtNotas = reg.notas ? `<div style="font-size:0.8rem; background:#fff3cd; padding:5px; border-radius:5px; margin-top:5px;"><i class="fas fa-comment-dots"></i> ${reg.notas}</div>` : '';
            let fotoHTML = reg.fotoMin ? `<div style="margin-top:8px;"><img src="${reg.fotoMin}" style="width:50px; border-radius:5px; border:1px solid #ccc;"></div>` : '';
            let iaVisualHTML = (reg.analisisVisual && reg.analisisVisual.includes("Evaluación Visual")) ? `<div style="font-size:0.8rem; background:#e8eaf6; color:#4a148c; padding:5px; border-radius:5px; margin-top:5px;"><i class="fas fa-robot"></i> IA Visual: OK (Ver Excel)</div>` : '';
            
            return `
            <div class="registro-card">
              <div style="font-weight:bold; margin-bottom:3px;"><i class="fas fa-store"></i> ${reg.tienda} ${btnMapa}</div>
              <div style="font-size:0.8rem; color:#666; margin-bottom:5px;">Hora: ${reg.hora}</div>
              <div style="font-size:0.85rem; margin-bottom:5px;">${resumenMarcas}</div>
              ${resumenPop}
              <div style="font-size:0.8rem; color:var(--eval); font-weight:bold; margin-top:5px;"><i class="fas fa-star"></i> Tácticas: ${cumplidosVisita}/${totalVisita}</div>
              ${txtNotas}
              ${fotoHTML}
              ${iaVisualHTML}
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  });
  
  contenedor.innerHTML = htmlResult;
}

function toggleDetalles(index) { 
  const det = document.getElementById(`detalles-${index}`); 
  const ico = document.getElementById(`icon-${index}`); 
  det.classList.toggle("show"); 
  ico.classList.toggle("fa-chevron-up"); 
  ico.classList.toggle("fa-chevron-down"); 
}

function exportarExcel() {
  const datosExport = obtenerDatosFiltrados().principal; 
  if (datosExport.length === 0) return alert("No hay registros en el filtro seleccionado.");
  
  let csvContent = "\uFEFF"; 
  let encabezados = ["Fecha", "Hora", "Distribuidor", "Vendedor", "Zona", "Tienda", "Notas_Competencia", "Latitud", "Longitud", "IA_Visual_Exhibicion"];
  
  marcas.map(m => m.nombre).forEach(m => encabezados.push(m)); 
  materialesPOP.forEach(p => encabezados.push(`[POP] ${p}`)); 
  aspectosDiarios.forEach(a => encabezados.push(`[DIARIA] ${a}`)); 
  aspectosVisita.forEach(a => encabezados.push(`[VISITA] ${a}`));
  
  csvContent += encabezados.join(";") + "\r\n";
  
  datosExport.forEach(v => {
    let txtIA = v.analisisVisual ? v.analisisVisual.replace(/<[^>]*>?/gm, '').replace(/(\r\n|\n|\r)/gm, " ") : "Sin Análisis";
    let fila = [v.fechaISO, v.hora, `"${v.distribuidor}"`, `"${v.vendedor}"`, `"${v.zona}"`, `"${v.tienda}"`, `"${v.notas || ''}"`, (v.lat || "Sin datos"), (v.lng || "Sin datos"), `"${txtIA}"`];
    
    marcas.forEach(marca => { 
      const r = v.resultados.find(x => x.marca === marca.nombre); 
      fila.push(r ? (r.disponible ? "SI" : "NO") : "N/A"); 
    });
    
    materialesPOP.forEach(pop => { 
      if(v.pop) { 
        const p = v.pop.find(x => x.nombre === pop); 
        fila.push(p && p.presente ? "SI" : "NO"); 
      } else { 
        fila.push("N/A"); 
      } 
    });
    
    aspectosDiarios.forEach(aspecto => { 
      if(v.evaluacionDiaria) { 
        const c = v.evaluacionDiaria.find(x => x.aspecto === aspecto); 
        fila.push(c && c.cumple ? "SI" : "NO"); 
      } else { 
        fila.push("N/A"); 
      } 
    });
    
    aspectosVisita.forEach(aspecto => { 
      if(v.evaluacionVisita) { 
        const c = v.evaluacionVisita.find(x => x.aspecto === aspecto); 
        fila.push(c && c.cumple ? "SI" : "NO"); 
      } else { 
        fila.push("N/A"); 
      } 
    });
    
    csvContent += fila.join(";") + "\r\n";
  });
  
  const link = document.createElement("a"); 
  link.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })); 
  link.download = `Auditorias_GenommaLab.csv`; 
  link.click();
}

// ==========================================
// 12. ESTADÍSTICAS Y PANEL DE CONTROL
// ==========================================
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
  
  document.getElementById("kpi-tiendas").innerText = vMain.length; 
  mostrarTendencia("trend-tiendas", vMain.length, vPrev.length, muestraTendencia); 
  
  const tasaActual = calcularTasa(vMain).tacticas; 
  const tasaAnterior = calcularTasa(vPrev).tacticas; 
  document.getElementById("kpi-tacticas").innerText = tasaActual + "%"; 
  mostrarTendencia("trend-tacticas", tasaActual, tasaAnterior, muestraTendencia);

  let dataMarcas = []; 
  let labelsMarcas = []; 
  
  marcas.forEach(m => { 
    let count = 0, evaluadas = 0; 
    vMain.forEach(v => { 
      const r = v.resultados.find(x => x.marca === m.nombre); 
      if(r) { evaluadas++; if(r.disponible) count++; } 
    }); 
    if(evaluadas > 0){ 
      labelsMarcas.push(m.nombre); 
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

  let clsHtml = `<p><strong>Periodo analizado:</strong> ${vMain.length} tiendas</p><h4 style="margin:15px 0 10px; color:var(--primary);">Marcas Genomma Lab:</h4>`; 
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

// INICIAR LA APP
renderizarApp();