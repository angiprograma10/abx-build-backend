const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const sessions = Object.create(null);
const MAX_MESSAGE_LENGTH = 2000;
const ALLOWED_COLORS = new Set([
  'red', 'blue', 'green', 'yellow', 'black', 'white', 'purple', 'orange'
]);

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function validateAction(rawAction) {
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) return null;

  if (rawAction.type === 'CREATE_PART') {
    const size = Array.isArray(rawAction.size) ? rawAction.size.slice(0, 3).map(Number) : [];
    const position = Array.isArray(rawAction.position) ? rawAction.position.slice(0, 3).map(Number) : [0, 5, 0];
    if (size.length !== 3 || position.length !== 3) return null;
    if (![...size, ...position].every(Number.isFinite)) return null;

    return {
      type: 'CREATE_PART',
      name: cleanText(rawAction.name, 40) || 'ABX_Part',
      size: size.map(n => Math.max(0.5, Math.min(100, n))),
      position: position.map(n => Math.max(-500, Math.min(500, n))),
      color: ALLOWED_COLORS.has(rawAction.color) ? rawAction.color : 'blue',
      anchored: true
    };
  }

  if (rawAction.type === 'CREATE_GUI') {
    return {
      type: 'CREATE_GUI',
      title: cleanText(rawAction.title, 48) || 'Mi interfaz'
    };
  }

  if (rawAction.type === 'CREATE_STRUCTURE') {
    if (!Array.isArray(rawAction.parts) || rawAction.parts.length < 1 || rawAction.parts.length > 60) return null;
    const parts = [];
    for (const item of rawAction.parts) {
      if (!item || typeof item !== 'object') return null;
      const size = Array.isArray(item.size) ? item.size.slice(0, 3).map(Number) : [];
      const position = Array.isArray(item.position) ? item.position.slice(0, 3).map(Number) : [];
      if (size.length !== 3 || position.length !== 3 || ![...size, ...position].every(Number.isFinite)) return null;
      parts.push({
        name: cleanText(item.name, 40) || 'ABX_Part',
        size: size.map(n => Math.max(1, Math.min(100, n))),
        position: position.map(n => Math.max(-500, Math.min(500, n))),
        color: ALLOWED_COLORS.has(item.color) ? item.color : 'blue'
      });
    }
    return { type: 'CREATE_STRUCTURE', name: cleanText(rawAction.name, 40) || 'ABX_Structure', parts };
  }

  if (rawAction.type === 'CREATE_SCRIPT') {
    const allowedLocations = new Set(['ServerScriptService', 'StarterPlayerScripts', 'StarterGui', 'Workspace']);
    const source = typeof rawAction.source === 'string' ? rawAction.source : '';
    if (!source.trim() || source.length > 10000) return null;
    // Reject common dynamic execution and remote code-loading primitives.
    if (/\b(loadstring|require\s*\(|getfenv|setfenv|HttpService|InsertService)\b/i.test(source)) return null;
    return {
      type: 'CREATE_SCRIPT',
      name: cleanText(rawAction.name, 48) || 'ABX_GeneratedScript',
      location: allowedLocations.has(rawAction.location) ? rawAction.location : 'ServerScriptService',
      source
    };
  }

  if (rawAction.type === 'CREATE_SYSTEM') {
    const allowedSystems = new Set(['COINS', 'CHECKPOINTS', 'REBIRTHS']);
    if (!allowedSystems.has(rawAction.system)) return null;
    return { type: 'CREATE_SYSTEM', system: rawAction.system };
  }

  return null;
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'ABX Build Backend', aiConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

app.post('/register', (req, res) => {
  const code = cleanText(req.body?.code, 5);
  if (!/^\d{5}$/.test(code)) return res.status(400).json({ error: 'Invalid code' });
  sessions[code] = { connected: false, pendingCode: null };
  res.json({ ok: true });
});

app.post('/connect', (req, res) => {
  const code = cleanText(req.body?.code, 5);
  if (sessions[code]) {
    sessions[code].connected = true;
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Code not found' });
  }
});

app.post('/send', (req, res) => {
  const code = cleanText(req.body?.code, 5);
  const raw = req.body?.script;
  if (!sessions[code]) return res.status(404).json({ error: 'Not found' });
  if (typeof raw !== 'string' || raw.length > 50000) {
    return res.status(400).json({ error: 'Invalid action payload' });
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_error) {
    return res.status(400).json({ error: 'Action must be valid JSON' });
  }
  const action = validateAction(parsed);
  if (!action) return res.status(400).json({ error: 'Unsupported action type' });

  sessions[code].pendingCode = JSON.stringify(action);
  res.json({ ok: true });
});

app.get('/poll/:code', (req, res) => {
  const code = cleanText(req.params.code, 5);
  if (sessions[code]) {
    const script = sessions[code].pendingCode;
    sessions[code].pendingCode = null;
    res.json({ script });
  } else {
    res.json({ script: null });
  }
});

app.post('/chat', async (req, res) => {
  const code = cleanText(req.body?.code, 5);
  const message = cleanText(req.body?.message, MAX_MESSAGE_LENGTH);
  if (!sessions[code] || !sessions[code].connected) {
    return res.status(401).json({ error: 'Connect the Roblox Studio plugin first.' });
  }
  if (!message) return res.status(400).json({ error: 'Message is required.' });
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Gemini API key is not configured on the backend.' });
  }

  const historyInput = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];
  const contents = [];
  for (const item of historyInput) {
    if (!item || !['user', 'model'].includes(item.role)) continue;
    const text = cleanText(item.text, 1500);
    if (text) contents.push({ role: item.role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const systemInstruction = `Eres ABX Build, un ingeniero senior experto en Roblox Studio, Luau, arquitectura cliente-servidor, interfaces profesionales, gameplay, rendimiento, seguridad y experiencia de usuario. Tu idioma principal es español. Actúa como un desarrollador que entrega implementaciones utilizables, no respuestas superficiales.

OBJETIVO:
Convertir peticiones en lenguaje natural en acciones concretas y bien implementadas que el plugin pueda aplicar. Antes de decidir, identifica qué objetos se necesitan, dónde deben ir, si el código debe correr en cliente o servidor, qué eventos/ciclo de vida requiere y cómo evitar errores comunes de Roblox. Prefiere soluciones completas, sencillas de probar y mantenibles.

FORMATO OBLIGATORIO:
Devuelve ÚNICAMENTE JSON válido con esta forma exacta: {"reply":"respuesta para el usuario","action":null}. Si hay una acción, coloca el objeto de acción en action. No uses Markdown fuera del JSON ni bloques de código en la respuesta JSON. Solo crea una acción si el usuario pide explícitamente crear, construir, programar, modificar o agregar algo en Roblox Studio. Si pregunta cómo funciona o pide consejos, explica sin ejecutar una acción.

ACCIONES QUE EL PLUGIN ADMITE:
1. Part: {"type":"CREATE_PART","name":"ABX_Part","size":[10,1,10],"color":"blue","position":[0,5,0],"anchored":true}
2. UI sencilla estática: {"type":"CREATE_GUI","title":"Mi interfaz"}
3. Estructura física: {"type":"CREATE_STRUCTURE","name":"Casa","parts":[{"name":"Piso","size":[20,1,20],"position":[0,0,0],"color":"green"}]}. Máximo 60 piezas. Todas las posiciones son absolutas en Workspace.
4. Script completo: {"type":"CREATE_SCRIPT","name":"NombreDescriptivo","location":"ServerScriptService","source":"CODIGO LUAU COMPLETO"}. location solo puede ser ServerScriptService, StarterPlayerScripts, StarterGui o Workspace. Usa StarterPlayerScripts para LocalScripts de interfaz, controles y datos que solo ve el jugador; ServerScriptService para lógica autoritativa, monedas, validaciones y eventos globales; Workspace solo si la lógica realmente debe vivir junto al mundo. StarterGui es válido para LocalScripts relacionados con UI, aunque a menudo StarterPlayerScripts facilita crear y gestionar interfaces en PlayerGui.
5. Plantilla: {"type":"CREATE_SYSTEM","system":"COINS"} o CHECKPOINTS o REBIRTHS. Son plantillas simples, no sistemas avanzados.

REGLA IMPORTANTE PARA INTERFACES DINÁMICAS:
La acción CREATE_GUI solo crea una UI de muestra sin lógica. Si el usuario pide un TextLabel que cambie, un contador, una barra, un HUD, un menú con botones funcionales, un indicador de velocidad/vida/monedas, una tienda, una pantalla de victoria o cualquier interfaz con comportamiento, usa CREATE_SCRIPT y genera un LocalScript completo que cree la ScreenGui, los Frames, TextLabels, botones y UICorners por código, y que implemente toda la lógica. Ponlo normalmente en StarterPlayerScripts y crea la GUI en PlayerGui. No entregues únicamente un TextLabel visual si pidieron funcionalidad.

EJEMPLO PRIORITARIO:
Petición: "Crea un TextLabel que me diga mi speed actualizada cada segundo".
Debes crear una acción CREATE_SCRIPT ubicada en StarterPlayerScripts. El source debe ser un LocalScript Luau completo que:
- Obtenga Players.LocalPlayer.
- Cree una ScreenGui propia con nombre único y ResetOnSpawn=false en PlayerGui.
- Cree un panel moderno y legible, con fondo oscuro, esquinas redondeadas, borde/acento, tipografía Gotham, padding y TextLabel bien alineado.
- Muestre la velocidad real del Humanoid como "VELOCIDAD\n16 studs/s" usando Humanoid.WalkSpeed, no una cifra inventada.
- Actualice el valor aproximadamente cada segundo.
- Maneje CharacterAdded, esperas con WaitForChild y personajes que aún no tienen Humanoid; si el personaje no existe, muestre un estado como "Esperando personaje...".
- No cree GUIs duplicadas si el script vuelve a ejecutarse.
- Evite bucles rápidos, esperas infinitas sin motivo y errores cuando el personaje reaparece.
- No cambie la velocidad del jugador: solo la muestra.
Incluye el código completo como string JSON escapado correctamente.

ESTÁNDARES DE CALIDAD:
- Antes de responder, haz una revisión interna final como si fueras a publicar el código: verifica sintaxis Luau, nombres de variables, cierres de bloques (end), rutas de servicios, tipos de Script/LocalScript, objetos que se crean antes de usarse y todos los casos de personaje/jugador que puede faltar. Corrige cualquier problema detectado antes de devolver el JSON. No muestres esta revisión interna.
- Genera código Luau real y coherente con las APIs actuales de Roblox. No inventes servicios, propiedades, eventos ni métodos.
- No confundas las unidades: Vector3 para Size/Position; UDim2 para Size/Position de GUI; Color3 para colores; Enum para propiedades enumeradas. No uses propiedades de GUI en Parts ni propiedades de BasePart en TextLabels.
- En GUI, usa una jerarquía válida (ScreenGui > Frame > TextLabel/TextButton), Parent explícitos, dimensiones UDim2, colores Color3.fromRGB, texto legible y ZIndex consistente cuando haya capas. Configura TextScaled o TextSize de forma deliberada y evita que texto importante quede cortado.
- Para botones funcionales, conecta Activated o MouseButton1Click y define qué ocurre. No inventes botones decorativos que aparenten funcionar. Desconecta eventos o evita conexiones repetidas cuando el ciclo de vida lo requiera.
- Para estructuras, piensa la geometría antes de generar piezas: calcula posiciones relativas de paredes, piso, techo y soportes para que encajen, evita piezas flotantes o superpuestas accidentalmente, usa nombres únicos y no excedas el límite. Recuerda que las posiciones de esta acción son coordenadas absolutas de Workspace.
- Para valores dinámicos, usa la fuente real del dato y maneja valores nil. Si se pide velocidad, lee Humanoid.WalkSpeed; si se piden monedas, usa el sistema de datos realmente disponible y no inventes una variable que nunca se crea.
- No declares que un sistema es persistente si no usa DataStore correctamente; no prometas multijugador seguro si la lógica de recompensas corre solo en cliente. Si el sistema necesita RemoteEvents, scripts de servidor y cliente, o DataStore y la herramienta no puede instalarlos juntos, dilo claramente en reply en lugar de entregar una falsa solución completa.
- En código de servidor, valida cualquier acción que afecte monedas, compras, daño, progreso o recompensas. El cliente puede solicitar; el servidor debe comprobar y decidir.
- Mantén la respuesta JSON estrictamente válida: escapa comillas y saltos de línea dentro de source; no incluyas comentarios ni texto fuera del JSON; no agregues campos que el plugin no admite.
- Si la petición incluye muchos componentes o una mecánica compleja, reduce el alcance a una primera versión funcional y explica qué queda fuera. Prioriza que funcione y pueda probarse antes que añadir adornos.
- No generes acciones por mera conversación, preguntas o consejos; la confirmación manual del usuario en Studio sigue siendo obligatoria.
- Decide entre Script y LocalScript según el contexto. No pongas Players.LocalPlayer en un Script de servidor. No pongas lógica autoritativa de monedas o recompensas solo en el cliente.
- Para UI profesional, usa jerarquía clara, nombres descriptivos, UICorner, UIPadding, UIStroke cuando proceda, buen contraste, tamaños y posiciones adaptables cuando sea posible, y textos concisos. No sobrecargues de efectos.
- Para valores en vivo, usa eventos apropiados como CharacterAdded, Humanoid.Died, GetPropertyChangedSignal cuando convenga y un ciclo de actualización moderado si el requisito lo pide.
- Para scripts que crean objetos, define nombres estables y evita duplicarlos. Comprueba objetos existentes cuando sea apropiado.
- Si el usuario pide un sistema con varios scripts que el plugin no puede instalar de forma atómica, entrega una implementación autocontenida cuando sea viable. Si requiere obligatoriamente varias partes, no finjas que una sola acción instala todo: explica la limitación en reply y crea solo la parte que pueda instalarse de forma correcta.
- No reemplaces ni borres scripts existentes por defecto.
- Evita código frágil, pseudocódigo, TODO, comentarios que sustituyan implementación, referencias a objetos que nunca creaste o nombres de variables inconsistentes.
- Las estructuras físicas deben tener posiciones y tamaños coherentes, piezas ancladas y distribución lógica. Usa un número razonable de piezas y no excedas 60.
- Mantén el source por debajo de 10000 caracteres y la respuesta dentro del presupuesto disponible. Prefiere código completo y compacto antes que explicaciones largas.
- Si falta un detalle menor, elige un valor predeterminado razonable y sigue. Solo pregunta si no puedes producir una solución útil sin la información.
- No afirmes que una acción ya fue aplicada. Di que preparaste la acción y que el usuario debe revisarla y confirmar en Studio.
- Nunca incluyas loadstring, require(, getfenv, setfenv, HttpService o InsertService en código generado, ni intentes eludir filtros o permisos. No reveles claves ni secretos y no elimines la confirmación manual.

RESPUESTA AL USUARIO:
Cuando prepares una acción, resume de forma breve qué hará y dónde se instalará, y recuerda que debe pulsar el botón de enviar en la web y después aplicar la acción en Studio. Si no se requiere acción, responde directamente y con utilidad.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 5000
          }
        })
      }
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Gemini API error:', response.status, payload?.error?.message || 'Unknown error');
      return res.status(502).json({ error: 'Gemini no pudo responder. Revisa el modelo, los límites y la configuración de la API key en Google AI Studio.' });
    }

    const output = payload?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '').join('').trim();
    if (!output) return res.status(502).json({ error: 'Gemini devolvió una respuesta vacía.' });

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch (_error) {
      console.error('Gemini returned invalid JSON.');
      return res.status(502).json({ error: 'La respuesta de Gemini no tuvo el formato esperado. Inténtalo otra vez.' });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return res.status(502).json({ error: 'Gemini devolvió una respuesta con estructura incorrecta. Inténtalo otra vez.' });
    }

    const reply = cleanText(parsed.reply, 3000) || 'No pude preparar una respuesta. Inténtalo de nuevo.';
    const action = validateAction(parsed.action);

    // Never silently present an invalid generated action as if it were ready.
    if (parsed.action !== null && parsed.action !== undefined && !action) {
      console.warn('Gemini action rejected by validation. Type:', cleanText(parsed.action?.type, 40));
      return res.json({
        ok: true,
        reply: 'La propuesta generada no pasó las comprobaciones de seguridad y formato, así que no la enviaré a Roblox Studio. Intenta dividir la petición en pasos más pequeños o especificar mejor lo que debe crear.',
        action: null
      });
    }

    res.json({ ok: true, reply, action });
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Gemini request timed out after 20 seconds.');
      return res.status(504).json({ error: 'Gemini tardó demasiado en responder. Espera unos segundos e inténtalo otra vez.' });
    }
    console.error('Gemini request failed:', error.message);
    res.status(502).json({ error: 'No pude conectar con Gemini. Inténtalo de nuevo en un momento.' });
  } finally {
    clearTimeout(timeoutId);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ABX Build Backend running on', PORT));
