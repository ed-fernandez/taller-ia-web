// Configuración de despliegue de Taller IA web. Este archivo SÍ va al repositorio y no lleva secretos.
//
// La dirección de la cola (Apps Script) llega a cada dispositivo por el enlace de invitación
//   https://<donde-esté-publicada>/#q=<ID de la implementación>
// y se guarda en ese dispositivo. Así la web puede estar en un alojamiento público sin exponer la cola.
//
// Si el alojamiento es privado, se puede fijar aquí:  window.TALLER_CONFIG = { queueUrl: "https://script.google.com/macros/s/<ID>/exec" };
// Otras opciones:  demo: true (simula el taller, para capturas y pruebas) · pinLength: 6
//                  avisarEd: "https://wa.me/34XXXXXXXXX" o "mailto:…" (botón «Avisar a Ed» cuando la cola no contesta)
window.TALLER_CONFIG = {};
