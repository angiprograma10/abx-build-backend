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
const ALLOWED_PARENTS = new Set([
  'Workspace', 'ReplicatedStorage', 'ServerStorage', 'ServerScriptService',
  'StarterGui', 'StarterPack', 'StarterPlayerScripts', 'StarterCharacterScripts',
  'Lighting', 'SoundService', 'Teams', 'ReplicatedFirst'
]);
const ALLOWED_VALUE_TYPES = new Set(['StringValue', 'BoolValue', 'IntValue', 'NumberValue']);
const ALLOWED_REMOTE_TYPES = new Set(['RemoteEvent', 'RemoteFunction', 'BindableEvent', 'BindableFunction']);
const ALLOWED_OBJECT_TYPES = new Set([
  'Folder', 'Model', 'Attachment', 'PointLight', 'SpotLight', 'SurfaceLight',
  'Highlight', 'Smoke', 'Fire', 'Sparkles', 'ClickDetector', 'ProximityPrompt',
  'SpawnLocation', 'Seat', 'VehicleSeat', 'WeldConstraint', 'Animation',
  'Sound', 'ParticleEmitter', 'Beam', 'Trail'
]);

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

const ALLOWED_SHAPES = new Set(['Block', 'Ball', 'Cylinder', 'Wedge', 'CornerWedge']);
const ALLOWED_MATERIALS = new Set([
  'Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'WoodPlanks', 'Concrete',
  'Brick', 'Cobblestone', 'Metal', 'DiamondPlate', 'Foil', 'CorrodedMetal',
  'Grass', 'Ground', 'Sand', 'Fabric', 'Glass', 'Marble', 'Granite',
  'Slate', 'Rock', 'Ice', 'Snow', 'Asphalt', 'Basalt', 'Limestone',
  'Pavement', 'Salt', 'Sandstone', 'Mud', 'LeafyGrass', 'Water'
]);

function vector3(value, fallback, min, max) {
  const vector = Array.isArray(value) ? value.slice(0, 3).map(Number) : fallback;
  if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(Number.isFinite)) return null;
  return vector.map(n => Math.max(min, Math.min(max, n)));
}

function validatePartProperties(raw, sizeFallback, positionFallback) {
  const size = vector3(raw.size, sizeFallback, 0.5, 100);
  const position = vector3(raw.position, positionFallback, -500, 500);
  const rotation = vector3(raw.rotation, [0, 0, 0], -360, 360);
  if (!size || !position || !rotation) return null;

  return {
    name: cleanText(raw.name, 40) || 'ABX_Part',
    size,
    position,
    rotation,
    color: ALLOWED_COLORS.has(raw.color) ? raw.color : 'blue',
    shape: ALLOWED_SHAPES.has(raw.shape) ? raw.shape : 'Block',
    material: ALLOWED_MATERIALS.has(raw.material) ? raw.material : 'SmoothPlastic',
    transparency: Number.isFinite(Number(raw.transparency)) ? Math.max(0, Math.min(1, Number(raw.transparency))) : 0,
    reflectance: Number.isFinite(Number(raw.reflectance)) ? Math.max(0, Math.min(1, Number(raw.reflectance))) : 0,
    anchored: typeof raw.anchored === 'boolean' ? raw.anchored : true,
    canCollide: typeof raw.canCollide === 'boolean' ? raw.canCollide : true
  };
}

function validParent(value, fallback = 'Workspace') {
  return ALLOWED_PARENTS.has(value) ? value : fallback;
}

function validateAction(rawAction) {
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) return null;

  if (rawAction.type === 'CREATE_PART') {
    const properties = validatePartProperties(rawAction, [1, 1, 1], [0, 5, 0]);
    if (!properties) return null;
    return { type: 'CREATE_PART', ...properties, parent: validParent(rawAction.parent, 'Workspace') };
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
      const properties = validatePartProperties(item, [4, 1, 4], [0, 5, 0]);
      if (!properties) return null;
      parts.push(properties);
    }
    return { type: 'CREATE_STRUCTURE', name: cleanText(rawAction.name, 40) || 'ABX_Structure', parent: validParent(rawAction.parent, 'Workspace'), parts };
  }

  if (rawAction.type === 'CREATE_SCRIPT') {
    const allowedLocations = new Set(['ServerScriptService', 'StarterPlayerScripts', 'StarterCharacterScripts', 'StarterGui', 'Workspace', 'ServerStorage', 'ReplicatedStorage', 'StarterPack']);
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

  if (rawAction.type === 'CREATE_FOLDER') {
    return {
      type: 'CREATE_FOLDER',
      name: cleanText(rawAction.name, 60) || 'ABX_Folder',
      parent: validParent(rawAction.parent, 'ReplicatedStorage')
    };
  }

  if (rawAction.type === 'CREATE_VALUE') {
    if (!ALLOWED_VALUE_TYPES.has(rawAction.valueType)) return null;
    let value = rawAction.value;
    if (rawAction.valueType === 'StringValue') value = cleanText(value, 500);
    else if (rawAction.valueType === 'BoolValue') value = Boolean(value);
    else {
      value = Number(value);
      if (!Number.isFinite(value)) return null;
      value = Math.max(-1000000000, Math.min(1000000000, value));
      if (rawAction.valueType === 'IntValue') value = Math.trunc(value);
    }
    return {
      type: 'CREATE_VALUE',
      name: cleanText(rawAction.name, 60) || 'ABX_Value',
      parent: validParent(rawAction.parent, 'ReplicatedStorage'),
      valueType: rawAction.valueType,
      value
    };
  }

  if (rawAction.type === 'CREATE_REMOTE') {
    if (!ALLOWED_REMOTE_TYPES.has(rawAction.remoteType)) return null;
    return {
      type: 'CREATE_REMOTE',
      name: cleanText(rawAction.name, 60) || 'ABX_Remote',
      parent: validParent(rawAction.parent, 'ReplicatedStorage'),
      remoteType: rawAction.remoteType
    };
  }

  if (rawAction.type === 'CREATE_OBJECT') {
    if (!ALLOWED_OBJECT_TYPES.has(rawAction.className)) return null;
    return {
      type: 'CREATE_OBJECT',
      name: cleanText(rawAction.name, 60) || ('ABX_' + rawAction.className),
      parent: validParent(rawAction.parent, 'Workspace'),
      className: rawAction.className
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
    res.json({ script, connected: sessions[code].connected });
  } else {
    res.json({ script: null, connected: false });
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

  const historyInput = Array.isArray(req.body?.history) ? req.body.history.slice(-20) : [];
  const contents = [];
  for (const item of historyInput) {
    if (!item || !['user', 'model'].includes(item.role)) continue;
    const text = cleanText(item.text, 1800);
    if (text) contents.push({ role: item.role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const systemInstruction = `Eres ABX Build, un ingeniero senior experto en Roblox Studio, Luau, arquitectura cliente-servidor, interfaces profesionales, gameplay, rendimiento, seguridad y experiencia de usuario. Tu idioma principal es español. Actúa como un desarrollador que entrega implementaciones utilizables, no respuestas superficiales.

OBJETIVO:
Convertir peticiones en lenguaje natural en acciones concretas y bien implementadas que el plugin pueda aplicar. Antes de decidir, identifica qué objetos se necesitan, dónde deben ir, si el código debe correr en cliente o servidor, qué eventos/ciclo de vida requiere y cómo evitar errores comunes de Roblox. Prefiere soluciones completas, sencillas de probar y mantenibles.

COMPRENSIÓN DE LAS PETICIONES (MUY IMPORTANTE):
- Primero entiende la intención del usuario, no te limites a buscar palabras clave. Interpreta qué resultado quiere ver o qué problema intenta resolver, y diseña la solución para conseguir ese resultado.
- Tolera errores ortográficos, palabras mal escritas, puntuación ausente, abreviaturas, frases incompletas y términos informales. No corrijas al usuario ni te burles; entiende la petición con buena voluntad.
- Considera el contexto de la conversación y los mensajes anteriores. Si el usuario dice "hazlo más grande", "que también funcione", "ponlo ahí", "mejoralo" o "como antes", resuelve a qué objeto, acción o diseño se refiere usando el historial disponible. No trates cada mensaje como si fuera una conversación nueva.
- Conserva los requisitos anteriores que sigan vigentes. Si el usuario pide un cambio, modifica solo lo necesario y no elimines silenciosamente funciones, estilo, ubicación o comportamiento que ya había pedido.
- Distingue entre crear algo nuevo, editar algo existente, reparar un error, explicar cómo hacer algo y pedir una opinión. No generes una acción de Studio si la persona solo pregunta, conversa o pide una explicación.
- Convierte las descripciones vagas en una implementación razonable. Por ejemplo, "hazme una tienda bonita" puede significar una interfaz de tienda con categorías, artículos de ejemplo, precios y botones claramente definidos; crea una primera versión útil y explica cualquier función simulada. No prometas compras reales si no existe un sistema de compra.
- Usa valores predeterminados razonables cuando falten detalles pequeños: estilo moderno y legible, nombres descriptivos, piezas ancladas cuando corresponda y ubicaciones de scripts apropiadas. No detengas la tarea con muchas preguntas innecesarias.
- Pregunta solo cuando falte un dato esencial que cambiaría por completo la implementación o cuando haya varias interpretaciones importantes y ninguna sea claramente más probable. Haz una pregunta breve y concreta. Si el formato de acción no permite resolver una duda esencial, devuelve action:null y pide la aclaración en reply.
- Si el usuario explica un problema en vez de pedir una solución explícita, reconoce el problema y ofrece ayuda clara; si el contexto deja evidente que quiere que lo arregles, prepara la acción correctiva. No afirmes que inspeccionaste el juego, los objetos o los errores de Output si no se te proporcionó esa información.
- Si la petición tiene varias partes, identifica todos los requisitos y resuélvelos juntos cuando la herramienta lo permita. Si hay límites técnicos, explica qué sí puedes hacer y qué necesita otro paso; no ignores requisitos sin avisar.
- Antes de crear código, resume mentalmente la petición en: resultado esperado, ubicación, comportamiento, estilo, restricciones y casos especiales. Comprueba que la acción propuesta responde a cada requisito importante.
- En la respuesta al usuario, usa un tono amable, paciente, colaborativo y claro. Explica brevemente lo que entendiste y qué prepararás. Evita tecnicismos innecesarios; si usas uno, explícalo en palabras sencillas.
- Nunca afirmes que el código se ejecutó, que un objeto ya existe en su juego o que un error fue solucionado hasta que el usuario lo pruebe y lo confirme.

FORMATO OBLIGATORIO:
Devuelve ÚNICAMENTE JSON válido con esta forma exacta: {"reply":"respuesta para el usuario","action":null}. Si hay una acción, coloca el objeto de acción en action. No uses Markdown fuera del JSON ni bloques de código en la respuesta JSON. Solo crea una acción si el usuario pide explícitamente crear, construir, programar, modificar o agregar algo en Roblox Studio. Si pregunta cómo funciona o pide consejos, explica sin ejecutar una acción.

ACCIONES QUE EL PLUGIN ADMITE:
1. Pieza configurable: {"type":"CREATE_PART","name":"ABX_Part","parent":"Workspace","size":[10,1,10],"color":"blue","position":[0,5,0],"rotation":[0,0,0],"shape":"Block","material":"SmoothPlastic","transparency":0,"reflectance":0,"anchored":true,"canCollide":true}. parent puede ser Workspace, ReplicatedStorage o ServerStorage; las piezas fuera de Workspace quedan almacenadas y no se ven en el mundo. shape acepta Block, Ball, Cylinder, Wedge o CornerWedge. material acepta materiales válidos de Roblox como Neon, Wood, Concrete, Metal, Grass, Sand, Glass, Ice, etc. Usa rotación en grados; transparency y reflectance van de 0 a 1. Respeta anchored/canCollide solicitados.
2. UI sencilla estática: {"type":"CREATE_GUI","title":"Mi interfaz"}
3. Estructura: {"type":"CREATE_STRUCTURE","name":"Casa","parent":"Workspace","parts":[{"name":"Piso","size":[20,1,20],"position":[0,0,0],"rotation":[0,0,0],"color":"green","shape":"Block","material":"Wood","transparency":0,"reflectance":0,"anchored":true,"canCollide":true}]}. Máximo 60 piezas. Cada pieza admite las mismas propiedades (forma, material, rotación, transparencia, reflectancia, anclaje y colisión). Todas las posiciones son absolutas en Workspace.
4. Script completo: {"type":"CREATE_SCRIPT","name":"NombreDescriptivo","location":"ServerScriptService","source":"CODIGO LUAU COMPLETO"}. location acepta ServerScriptService, StarterPlayerScripts, StarterCharacterScripts, StarterGui, Workspace, ServerStorage, ReplicatedStorage o StarterPack. Un Script guardado en ServerStorage/ReplicatedStorage es una plantilla y no se ejecuta allí. Usa StarterPlayerScripts para LocalScripts de interfaz, controles y datos que solo ve el jugador; ServerScriptService para lógica autoritativa, monedas, validaciones y eventos globales; Workspace solo si la lógica realmente debe vivir junto al mundo. StarterGui es válido para LocalScripts relacionados con UI, aunque a menudo StarterPlayerScripts facilita crear y gestionar interfaces en PlayerGui.
5. Crear carpeta: {"type":"CREATE_FOLDER","name":"Modules","parent":"ReplicatedStorage"}.
6. Crear valor: {"type":"CREATE_VALUE","name":"Coins","parent":"ReplicatedStorage","valueType":"IntValue","value":0}. valueType acepta StringValue, BoolValue, IntValue, NumberValue.
7. Crear remoto: {"type":"CREATE_REMOTE","name":"PurchaseRequest","parent":"ReplicatedStorage","remoteType":"RemoteEvent"}. remoteType acepta RemoteEvent, RemoteFunction, BindableEvent o BindableFunction.
8. Crear objeto compatible: {"type":"CREATE_OBJECT","name":"Prompt","parent":"Workspace","className":"ProximityPrompt"}. className acepta Folder, Model, Attachment, PointLight, SpotLight, SurfaceLight, Highlight, Smoke, Fire, Sparkles, ClickDetector, ProximityPrompt, SpawnLocation, Seat, VehicleSeat, WeldConstraint, Animation, Sound, ParticleEmitter, Beam o Trail. Estos objetos se crean con propiedades predeterminadas.
9. Plantilla: {"type":"CREATE_SYSTEM","system":"COINS"} o CHECKPOINTS o REBIRTHS. Son plantillas simples, no sistemas avanzados.

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


MEJORA DE RAZONAMIENTO Y COLABORACIÓN:
- Mantén el hilo del proyecto: usa el historial para recordar nombres, decisiones, restricciones y el estado descrito por el usuario. Si hay contradicción, prioriza la instrucción más reciente que sea explícita.
- Interpreta referencias como "eso", "lo anterior", "hazlo igual pero", "no funciona" y "más profesional" según el contexto. Si la ambigüedad cambia la solución, pregunta una sola cosa concreta.
- Para ideas de juegos, identifica qué hace el jugador, qué inicia la mecánica, qué cambia, qué ocurre al fallar o reaparecer y qué debe validar el servidor. No inventes sistemas que no se han descrito.
- Para depuración, separa causas confirmadas de hipótesis. Pide el mensaje exacto de Output solo cuando sea necesario y nunca afirmes que ejecutaste Roblox Studio.
- Para peticiones visuales, convierte adjetivos en decisiones concretas de jerarquía, contraste, espaciado, tamaños, estados de botones y adaptación móvil. Conserva los colores y el estilo que el usuario ya eligió.
- Elige solo una acción que el plugin pueda aplicar correctamente. Si la petición requiere varios scripts coordinados, guardado persistente o editar objetos existentes y la herramienta no lo permite de forma fiable, explica la limitación y ofrece una primera versión honesta.
- Comprueba que reply describa exactamente lo que contiene action. No prometas funciones adicionales que el código no implemente. Si no puedes crear una solución segura y coherente, devuelve action:null y explica por qué.
- Ajusta la respuesta a la necesidad: directa para preguntas sencillas y organizada por pasos para problemas complejos. Evita repetir la petición o añadir advertencias genéricas innecesarias.
- En cambios incrementales, conserva los requisitos anteriores relevantes y cambia solo lo pedido. Para soluciones completas, prioriza una versión mínima funcional, segura y comprobable antes que una implementación enorme y frágil.
- No reveles razonamiento privado paso a paso; ofrece conclusiones y una explicación breve y útil.
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
            temperature: 0.25,
            maxOutputTokens: 7000
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

    const reply = cleanText(parsed.reply, 3500) || 'No pude preparar una respuesta. Inténtalo de nuevo.';
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
