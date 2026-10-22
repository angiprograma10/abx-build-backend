'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

const CONFIG = Object.freeze({
  bodyLimit: '256kb',
  maxMessageLength: 4000,
  maxHistoryItems: 20,
  maxHistoryText: 1800,
  maxOutputTokens: 16000,
  geminiTimeoutMs: 90000,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  maxQueuedActions: 40,
  maxPlanActions: 30,
  pendingPlanTtlMs: 3 * 60 * 1000,
  maxActionPayload: 200000,
  maxScriptLength: 10000,
  maxTreeNodes: 300,
  maxTreeDepth: 15,
  maxStructureParts: 60,
  maxSessions: 2000,
  maxRequestsPerMinute: 90,
  maxChatRequestsPerMinute: 12
});

const sessions = new Map();
const rateBuckets = new Map();
// MVP daily quota ledger. Before a public launch, persist this in a database:
// Render instances can restart or scale, so in-memory quotas are not durable.
const dailyTokenUsage = new Map();
const DAILY_TOKEN_LIMIT = 10;

function validClientId(value) {
  const id = cleanText(value, 80);
  return /^[a-zA-Z0-9_-]{16,80}$/.test(id) ? id : '';
}
function tokenDay() {
  // Reset at midnight in Mexico City, the primary audience timezone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function usageFor(clientId) {
  const day = tokenDay();
  const used = dailyTokenUsage.get(clientId + ':' + day) || 0;
  return { dailyLimit: DAILY_TOKEN_LIMIT, used, remaining: Math.max(0, DAILY_TOKEN_LIMIT - used), day };
}
function spendDailyToken(clientId, amount = 1) {
  const cost = Math.max(1, Math.floor(Number(amount) || 1));
  const key = clientId + ':' + tokenDay();
  const used = dailyTokenUsage.get(key) || 0;
  if (used + cost > DAILY_TOKEN_LIMIT) return null;
  dailyTokenUsage.set(key, used + cost);
  return usageFor(clientId);
}

const ALLOWED_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.1-pro-preview'
]);
const ALLOWED_OPENAI_MODELS = new Set();
const ALLOWED_DEEPSEEK_MODELS = new Set();
const ALLOWED_GROQ_MODELS = new Set();
const ALLOWED_MISTRAL_MODELS = new Set();
function providerForModel(model) {
  if (ALLOWED_OPENAI_MODELS.has(model)) return 'openai';
  if (ALLOWED_DEEPSEEK_MODELS.has(model)) return 'deepseek';
  if (ALLOWED_GROQ_MODELS.has(model)) return 'groq';
  if (ALLOWED_MISTRAL_MODELS.has(model)) return 'mistral';
  return 'gemini';
}
const MODEL_TIER_INSTRUCTIONS = Object.freeze({
  'gemini-3.8-flash': `
NIVEL 4 — CONSTRUCTOR PRINCIPAL ABX BUILD
Trata la petición como un resultado de Studio, no como una lista de nombres. Antes del JSON, organiza mentalmente objetivo y criterios de aceptación, jerarquía espacial/visual, dependencias, orden de acciones, conexiones funcionales y revisión final. En construcciones 3D define origen, escala, orientación, separación y puntos de unión; apoya edificios en el suelo, alinea paredes y techos, deja rutas transitables y evita piezas flotantes o duplicadas. En UI define propósito, jerarquía, layout, anclajes, tamaños, colores, estados, acciones de botones y feedback; no uses posiciones aleatorias ni mezcles UIListLayout con hijos posicionados manualmente. En scripts comprueba contexto servidor/cliente, rutas, eventos, validación, ciclo de vida y limpieza. Prioriza que todo quede conectado y bien montado, no solo que existan los objetos.
`,
  'gemini-3.1-pro-preview': `
NIVEL 5 — ARQUITECTO DE PROYECTOS COMPLEJOS
Planifica soluciones grandes por fases y dependencias. Comprueba que nombres, rutas, RemoteEvent, Value, ModuleScript, Script, LocalScript y elementos UI coincidan exactamente entre acciones. Usa arquitectura cliente-servidor segura, scripts con responsabilidades claras y UI coherente. Para construcciones crea primero base, luego soportes/paredes, techo, accesos y detalles; valida escala, alineación, uniones, colisiones y espacio jugable. Para UI crea contenedor/layout antes de hijos, establece propiedades explícitas y conecta botones a lógica real. Audita requisito por requisito y corrige acciones incompletas o contradictorias. No inventes capacidades del plugin ni afirmes pruebas no ejecutadas.
`,
  'gemini-3.5-flash-lite': `
NIVEL 1 — VELOCIDAD Y PRECISIÓN PRÁCTICA
Resuelve rápido y directamente. Para cambios pequeños, usa el mínimo de acciones necesarias sin sacrificar funcionalidad. Identifica ambigüedades importantes; si puedes tomar una decisión razonable y reversible, tómala. Comprueba nombres, rutas, tipos y dependencias. No agregues sistemas que no se pidieron.
`,
  'gemini-3.5-flash': `
NIVEL 2 — DESARROLLADOR ROBLOX EQUILIBRADO
Además del nivel 1, interpreta el objetivo completo y anticipa dependencias. Para cada función conecta entrada, lógica, estado y resultado visible. Diseña UI adaptable, con jerarquía visual, restricciones de tamaño y feedback. En scripts, cubre inicialización, estados vacíos, errores y limpieza de eventos. Mantén soluciones simples y rápidas.
`,
  'gemini-3-flash-preview': `
NIVEL 3 — CONSTRUCTOR Y PROGRAMADOR AVANZADO
Además de los niveles 1 y 2, planea el orden de construcción antes de emitir acciones. Divide sistemas en servidor/cliente/módulos según corresponda; crea primero carpetas, valores y remotos requeridos. Para juegos, entrega un ciclo jugable conectado (inicio, acción principal, recompensa, UI y reinicio). Revisa mentalmente el contrato de cada acción y los enlaces entre scripts. Prioriza resultados completos, no solo objetos decorativos.
`,
  'mistral/ministral-14b-2512': `
NIVEL 4 — ARQUITECTO EXPERTO
Además de los niveles anteriores, evalúa mantenibilidad, seguridad, rendimiento y crecimiento del proyecto. Usa módulos cohesivos y patrones OOP solo cuando aporten valor. Valida en servidor todas las operaciones sensibles y limita frecuencia de remotos. Diseña interfaces consistentes y pulidas. No dependas de frameworks o assets que no estén disponibles; si una capacidad falta en el esquema, elige la alternativa compatible más cercana y dilo con claridad.
`,
  'groq/openai/gpt-oss-120b': `
NIVEL 5 — INGENIERO PRINCIPAL ABX BUILD
Aplica todos los niveles anteriores con una auditoría final rigurosa. Descompón la petición en requisitos verificables; asigna cada requisito a acciones concretas y comprueba que no haya referencias rotas, scripts sin dependencias, UI sin lógica o lógica sin feedback. Prefiere la solución más completa que quepa en el contrato permitido, pero evita complejidad superflua. Considera exploits, concurrencia, persistencia, recuperación de errores y coste de ejecución cuando sean relevantes. No inventes APIs, IDs, pruebas ni dependencias. Si la solicitud es grande, entrega un MVP jugable coherente y declara lo pendiente.
`
});
function modelTierInstruction(model) {
  return MODEL_TIER_INSTRUCTIONS[model] || MODEL_TIER_INSTRUCTIONS['gemini-3.5-flash-lite'];
}

const JSON_CONTRACT_INSTRUCTION = `
CONTRATO DE SALIDA OBLIGATORIO:
- Devuelve SOLO un objeto JSON válido, sin Markdown, sin bloques de código y sin texto fuera del JSON.
- La forma exacta es {"reply":"mensaje breve en español","actions":[]} o {"reply":"resumen","actions":[{"type":"TIPO_ADMITIDO", "...":"..."}]}.
- La propiedad actions siempre debe existir y ser un array. Nunca uses "action" singular como propiedad de salida.
- Usa únicamente tipos de acción y propiedades admitidos por el esquema ABX Build. No inventes acciones, propiedades, rutas de API ni dependencias.
- Escapa comillas y saltos de línea correctamente dentro de strings JSON.
- Para preguntas sin cambios, responde con actions vacío. Para construcciones, ordena acciones para que las dependencias existan antes de los scripts que las necesitan.
- No sacrifiques la funcionalidad principal por decoración. Para tareas simples, entrega una solución compacta. Para juegos completos, conecta escenario, ciclo jugable, UI, lógica y reinicio según el alcance solicitado.
- Nunca afirmes que una acción se ejecutó o probó en Roblox Studio si no hay confirmación real.
`;

function taskProfile(message, buildMode) {
  const text = String(message || '');
  const professional = /profesional|professional|top\s*global|AAA|avanzad[oa]|completo|full.game|multijugador|persisten|guardar datos|econom[ií]a|inventario|misiones|sistema[s]?|robusto|escalable|producci[oó]n|arquitectura|depur|debug|error|fall[oa]|repar|arregl|corrig|refactor|optimiza|rendimiento|accesibilidad/i.test(text);
  const game = buildMode === 'full-game' || /juego|game|obby|simulador|simulator|tycoon|rpg|rondas|niveles|mapa completo/i.test(text);
  const build = /crea|crear|construye|construir|diseña|diseñar|genera|generar|programa|programar|implementa|implementar|arregla|arreglar|corrige|corregir|modifica|modificar|haz|hacer|build|create|design|generate|script|interfaz|ui|sistema|depur|debug|repar|fall[oa]|error|refactor|optimiza/i.test(text);
  const connectedSystem = /conectad[oa]|funcional|interactivo|dependencias|cliente|servidor|remoteevent|remotefunction|guardar datos|persisten|inventario|econom[ií]a|misiones|recompensas|multijugador|arquitectura|seguridad|rendimiento/i.test(text);
  if (game && professional) return { tier: 'professional', maxTokens: 12000, reasoning: 'high' };
  if (game) return { tier: 'game', maxTokens: 6500, reasoning: 'medium' };
  if (professional || (build && connectedSystem)) return { tier: 'professional-system', maxTokens: 6500, reasoning: 'high' };
  if (build) return { tier: 'construction', maxTokens: 3500, reasoning: 'medium' };
  return { tier: 'simple', maxTokens: 2200, reasoning: 'low' };
}

function apiKeyForProvider(provider) {
  return provider === 'openai' ? OPENAI_API_KEY
    : provider === 'deepseek' ? DEEPSEEK_API_KEY
    : provider === 'groq' ? GROQ_API_KEY
    : provider === 'mistral' ? MISTRAL_API_KEY
    : GEMINI_API_KEY;
}

const ALLOWED_PARENTS = new Set([
  'Workspace', 'ReplicatedStorage', 'ServerStorage',
  'ServerScriptService', 'StarterGui', 'StarterPack',
  'StarterPlayer', 'StarterPlayerScripts',
  'StarterCharacterScripts', 'Lighting', 'SoundService',
  'Teams', 'ReplicatedFirst'
]);

const SCRIPT_LOCATIONS = new Set([
  'ServerScriptService', 'StarterPlayerScripts',
  'StarterCharacterScripts', 'StarterGui', 'Workspace',
  'ServerStorage', 'ReplicatedStorage', 'StarterPack'
]);

const VALUE_TYPES = new Set([
  'StringValue', 'BoolValue', 'IntValue', 'NumberValue'
]);

const REMOTE_TYPES = new Set([
  'RemoteEvent', 'RemoteFunction',
  'BindableEvent', 'BindableFunction'
]);

const OBJECT_TYPES = new Set([
  'Folder', 'Model', 'Attachment', 'PointLight', 'SpotLight',
  'SurfaceLight', 'Highlight', 'Smoke', 'Fire', 'Sparkles',
  'ClickDetector', 'ProximityPrompt', 'SpawnLocation', 'Seat',
  'VehicleSeat', 'WeldConstraint', 'Animation', 'Sound',
  'ParticleEmitter', 'Beam', 'Trail'
]);

const SHAPES = new Set([
  'Block', 'Ball', 'Cylinder', 'Wedge', 'CornerWedge', 'Truss', 'Mesh'
]);

const MATERIALS = new Set([
  'Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'WoodPlanks',
  'Concrete', 'Brick', 'Cobblestone', 'Metal', 'DiamondPlate',
  'Foil', 'CorrodedMetal', 'Grass', 'Ground', 'Sand', 'Fabric',
  'Glass', 'Marble', 'Granite', 'Slate', 'Rock', 'Ice', 'Snow',
  'Asphalt', 'Basalt', 'Limestone', 'Pavement', 'Salt',
  'Sandstone', 'Mud', 'LeafyGrass', 'Water'
]);

const COLORS = new Set([
  'red', 'blue', 'green', 'yellow', 'black', 'white', 'purple',
  'orange', 'brown', 'beige', 'tan', 'cream', 'gray', 'grey',
  'dark gray', 'dark grey', 'light gray', 'light grey',
  'dark blue', 'light blue', 'navy blue', 'cyan', 'teal',
  'turquoise', 'sky blue', 'lime green', 'dark green',
  'olive green', 'mint', 'pink', 'hot pink', 'magenta',
  'coral', 'salmon', 'peach', 'red orange', 'maroon',
  'burgundy', 'gold', 'gold yellow', 'silver',
  'dark stone grey', 'medium stone grey', 'light stone grey',
  'institutional white', 'flint', 'sand red', 'brick yellow',
  'earth green', 'pastel brown', 'really black', 'really red',
  'bright blue', 'bright yellow', 'bright orange'
]);

const ALLOWED_ACTIONS = new Set([
  'CREATE_PART', 'CREATE_GUI', 'CREATE_STRUCTURE',
  'CREATE_SCRIPT', 'CREATE_FOLDER', 'CREATE_VALUE',
  'CREATE_REMOTE', 'CREATE_OBJECT', 'CREATE_SYSTEM',
  'CREATE_TREE', 'SET_PROPERTIES', 'SET_ATTRIBUTE',
  'DELETE_INSTANCE', 'MOVE_INSTANCE', 'DUPLICATE_INSTANCE',
  'INSPECT_PATH', 'FIND_INSTANCES', 'INSPECT_PROJECT',
  'INSPECT_SELECTION'
]);

function cleanText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function isObject(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n)
    ? Math.max(min, Math.min(max, n))
    : fallback;
}

function vector3(value, fallback, min, max) {
  const source = Array.isArray(value) ? value : fallback;
  if (!Array.isArray(source) || source.length !== 3) return null;

  const result = source.map(Number);
  if (!result.every(Number.isFinite)) return null;

  return result.map(n => Math.max(min, Math.min(max, n)));
}

function validParent(value, fallback = 'Workspace') {
  return ALLOWED_PARENTS.has(value) ? value : fallback;
}

function layoutPosition(index, size = [4, 1, 4]) {
  // Safe fallback for a part whose intended position was omitted.
  const pitchX = Math.max(12, size[0] + 3);
  const pitchZ = Math.max(12, size[2] + 3);
  return [
    (index % 6) * pitchX,
    5 + Math.max(0, size[1] / 2 - 0.5),
    Math.floor(index / 6) * pitchZ
  ];
}

function layoutPartsWithoutOverlap(parts) {
  // Pack parts into a grid using the largest part in each column/row.
  const columns = Math.min(6, parts.length);
  const rows = Math.ceil(parts.length / columns);
  const columnWidths = Array(columns).fill(0);
  const rowDepths = Array(rows).fill(0);
  parts.forEach((part, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    columnWidths[col] = Math.max(columnWidths[col], part.size[0]);
    rowDepths[row] = Math.max(rowDepths[row], part.size[2]);
  });
  const columnCenters = [];
  const rowCenters = [];
  let cursorX = 0;
  for (let col = 0; col < columns; col++) {
    columnCenters[col] = cursorX + columnWidths[col] / 2;
    cursorX += columnWidths[col] + 3;
  }
  let cursorZ = 0;
  for (let row = 0; row < rows; row++) {
    rowCenters[row] = cursorZ + rowDepths[row] / 2;
    cursorZ += rowDepths[row] + 3;
  }
  return parts.map((part, i) => [
    columnCenters[i % columns],
    5 + Math.max(0, part.size[1] / 2 - 0.5),
    rowCenters[Math.floor(i / columns)]
  ]);
}

function validatePart(raw, defaults = {}) {
  if (!isObject(raw)) return null;

  const size = vector3(raw.size, defaults.size || [4, 1, 4], 0.1, 100);
  const fallbackPosition = defaults.position || [0, 5, 0];
  const position = vector3(raw.position, fallbackPosition, -500, 500);
  const rotation = vector3(raw.rotation, [0, 0, 0], -360, 360);

  if (!size || !position || !rotation) return null;

  return {
    name: cleanText(raw.name, 60) || 'ABX_Part',
    size,
    position,
    rotation,
    color: COLORS.has(raw.color) ? raw.color : 'blue',
    shape: SHAPES.has(raw.shape) ? raw.shape : 'Block',
    material: MATERIALS.has(raw.material)
      ? raw.material : 'SmoothPlastic',
    transparency: clampNumber(raw.transparency, 0, 0, 1),
    reflectance: clampNumber(raw.reflectance, 0, 0, 1),
    anchored: typeof raw.anchored === 'boolean' ? raw.anchored : true,
    canCollide: typeof raw.canCollide === 'boolean'
      ? raw.canCollide : true
  };
}


function removeExactDuplicateVolumes(parts) {
  // Remove accidental, fully coincident opaque parts. Partial intersections are
  // deliberately preserved because walls, floors, roofs and trim may need to meet.
  const seen = new Set();
  const kept = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const key = part.shape + '|' + [
      ...part.position, ...part.size, ...part.rotation
    ].map(n => Number(n).toFixed(3)).join('|');
    const duplicate = seen.has(key) && part.transparency === 0;
    if (!duplicate) {
      kept.push(part);
      if (part.transparency === 0) seen.add(key);
    }
  }
  return kept.reverse();
}


const GUI_VISUAL = new Set(['Frame','ScrollingFrame','TextLabel','TextButton','TextBox','ImageLabel','ImageButton','ViewportFrame','CanvasGroup']);
const GUI_LAYOUT = new Set(['UIListLayout','UIGridLayout','UIPageLayout','UITableLayout']);

function repairGuiLayout(node) {
  if (!node || !Array.isArray(node.children)) return;
  const layouts = node.children.filter(child => GUI_LAYOUT.has(child.className));
  const visual = node.children.filter(child => GUI_VISUAL.has(child.className));
  const positioned = visual.filter(child => child.properties && child.properties.Position);
  if (layouts.length && positioned.length) {
    node.children = node.children.filter(child => !GUI_LAYOUT.has(child.className));
  }
  const hasLayout = node.children.some(child => GUI_LAYOUT.has(child.className));
  if (!hasLayout && visual.length > 1 && positioned.length === 0 && node.className !== 'ScreenGui') {
    visual.forEach((child, index) => {
      child.properties = child.properties || {};
      if (!child.properties.Size) {
        child.properties.Size = child.className === 'TextButton' || child.className === 'ImageButton'
          ? [1, -24, 0, 40]
          : [1, -24, 0, 32];
      }
      if (!child.properties.Position) {
        child.properties.Position = [0, 12, 0, 12 + index * 48];
      }
    });
  }
  node.children.forEach(repairGuiLayout);
}

function validateTreeNode(node, state, depth = 0) {
  if (!isObject(node) || depth > CONFIG.maxTreeDepth) return null;
  state.count++;
  if (state.count > CONFIG.maxTreeNodes) return null;

  const className = cleanText(node.className || node.class, 50);
  const name = cleanText(node.name, 60) || 'ABX_Object';

  const allowedClasses = new Set([
    'Folder', 'Model', 'Part', 'MeshPart', 'WedgePart',
    'CornerWedgePart', 'SpawnLocation', 'Seat', 'VehicleSeat',
    'Attachment', 'PointLight', 'SpotLight', 'SurfaceLight',
    'Highlight', 'ProximityPrompt', 'ClickDetector',
    'Sound', 'ParticleEmitter', 'Beam', 'Trail',
    'StringValue', 'BoolValue', 'IntValue', 'NumberValue',
    'ScreenGui', 'BillboardGui', 'SurfaceGui', 'Frame', 'ScrollingFrame',
    'ViewportFrame', 'CanvasGroup', 'TextLabel', 'TextButton', 'TextBox',
    'ImageLabel', 'ImageButton', 'VideoFrame', 'UICorner', 'UIStroke',
    'UIGradient', 'UIPadding', 'UIListLayout', 'UIGridLayout', 'UITableLayout',
    'UIPageLayout', 'UIScale', 'UITextSizeConstraint', 'UIAspectRatioConstraint',
    'Folder', 'Model', 'Decal', 'Texture', 'SpecialMesh', 'SurfaceAppearance',
    'Smoke', 'Fire', 'Sparkles', 'Team', 'Atmosphere', 'Sky', 'BloomEffect',
    'BlurEffect', 'ColorCorrectionEffect', 'DepthOfFieldEffect', 'SunRaysEffect',
    'RemoteEvent', 'RemoteFunction', 'BindableEvent', 'BindableFunction',
    'Configuration', 'ObjectValue', 'Color3Value', 'Vector3Value', 'CFrameValue'
  ]);

  if (!allowedClasses.has(className)) return null;

  const result = { name, className };

  if (className === 'Part' || className === 'MeshPart' ||
      className === 'WedgePart' || className === 'CornerWedgePart' ||
      className === 'SpawnLocation' || className === 'Seat' ||
      className === 'VehicleSeat') {
    const rawPart = node.properties || node;
    const index = state.partIndex || 0;
    state.partIndex = index + 1;
    const safeSize = vector3(rawPart.size, [4, 1, 4], 0.1, 100) || [4, 1, 4];
    const part = validatePart(rawPart, {
      size: [4, 1, 4], position: layoutPosition(index, safeSize)
    });
    if (!part) return null;

    // Preserve the model's explicit coordinates. Automatically shifting parts
    // with shared centers breaks intentional assemblies, wall trims and details.
    // Missing positions already receive a deterministic size-aware fallback above.
    result.properties = part;
  }

  if (node.properties !== undefined) {
    if (!isObject(node.properties)) return null;
    result.properties = result.properties || {};
    const allowedProperties = new Set([
      'Name', 'Text', 'TextSize', 'TextColor3', 'TextTransparency',
      'TextXAlignment', 'TextYAlignment', 'TextTruncate', 'BackgroundColor3',
      'BackgroundTransparency', 'BorderColor3', 'BorderSizePixel', 'BorderMode',
      'Visible', 'Enabled', 'Active', 'Selectable', 'Size', 'Position',
      'AnchorPoint', 'Rotation', 'Orientation', 'ZIndex', 'DisplayOrder',
      'ResetOnSpawn', 'IgnoreGuiInset', 'ZIndexBehavior', 'AutomaticSize',
      'TextWrapped', 'TextScaled', 'RichText', 'Font', 'LayoutOrder',
      'Image', 'ImageColor3', 'ImageTransparency', 'ScaleType', 'CanvasSize',
      'AutomaticCanvasSize', 'ScrollBarThickness', 'ScrollBarImageColor3',
      'CornerRadius', 'Thickness', 'Color', 'Transparency', 'PaddingTop',
      'PaddingBottom', 'PaddingLeft', 'PaddingRight', 'FillDirection',
      'HorizontalAlignment', 'VerticalAlignment', 'SortOrder', 'CellSize',
      'CellPadding', 'AspectRatio', 'AspectType', 'DominantAxis', 'Value',
      'Brightness', 'Range', 'Angle', 'Anchored', 'CanCollide', 'CanTouch',
      'CanQuery', 'Reflectance', 'Material', 'MaterialVariant', 'Shape',
      'CastShadow', 'Massless', 'MaxSpeed', 'Torque', 'TurnSpeed',
      'HoldDuration', 'MaxActivationDistance', 'ActionText', 'ObjectText',
      'RequiresLineOfSight', 'KeyboardKeyCode', 'StudsOffset', 'AlwaysOnTop',
      'LightInfluence', 'MaxDistance', 'Face', 'CanvasSize', 'PixelsPerStud',
      'Texture', 'TextureID', 'TextureId', 'Color3', 'SoundId', 'Volume',
      'PlaybackSpeed', 'Looped', 'Rate', 'Lifetime', 'Speed', 'SpreadAngle',
      'Enabled', 'Intensity', 'Size', 'Contrast', 'Saturation', 'TintColor',
      'Density', 'Haze', 'Glare', 'Decay', 'ColorMap', 'NormalMap',
      'MetalnessMap', 'RoughnessMap', 'MeshId', 'MeshType', 'Scale', 'Offset',
      'TeamColor', 'AutoAssignable', 'Brightness', 'Enabled'
    ]);
    const propertyAliases = {
      name:'Name', text:'Text', textsize:'TextSize', textcolor3:'TextColor3',
      texttransparency:'TextTransparency', backgroundcolor3:'BackgroundColor3',
      backgroundtransparency:'BackgroundTransparency', bordersizepixel:'BorderSizePixel',
      visible:'Visible', enabled:'Enabled', active:'Active', selectable:'Selectable',
      size:'Size', position:'Position', anchorpoint:'AnchorPoint', rotation:'Rotation',
      orientation:'Orientation', zindex:'ZIndex', displayorder:'DisplayOrder',
      resetonspawn:'ResetOnSpawn', ignoreguiinset:'IgnoreGuiInset',
      automaticcanvasize:'AutomaticCanvasSize', textwrapped:'TextWrapped',
      textscaled:'TextScaled', richtext:'RichText', font:'Font', layoutorder:'LayoutOrder',
      image:'Image', imagecolor3:'ImageColor3', imagetransparency:'ImageTransparency',
      canvassize:'CanvasSize', scrollbarthickness:'ScrollBarThickness',
      cornerradius:'CornerRadius', thickness:'Thickness', transparency:'Transparency',
      filldirection:'FillDirection', horizontalalignment:'HorizontalAlignment',
      verticalalignment:'VerticalAlignment', cellsize:'CellSize', cellpadding:'CellPadding',
      anchored:'Anchored', cancollide:'CanCollide', cantouch:'CanTouch', canquery:'CanQuery',
      reflectance:'Reflectance', material:'Material', materialvariant:'MaterialVariant',
      shape:'Shape', castshadow:'CastShadow', color:'Color', teamcolor:'TeamColor'
    };

    for (const [rawKey, rawValue] of Object.entries(node.properties)) {
      const key = propertyAliases[rawKey.toLowerCase()] || rawKey;
      if (!allowedProperties.has(key)) continue;
      let value = rawValue;
      // The model often copies the SET_PROPERTIES {value, kind} shape into
      // CREATE_TREE. Those objects used to be dropped, so Size and Position
      // never reached Studio and every element stacked at the top-left.
      if (isObject(value) && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'value')) {
        value = value.value;
      }
      if (isObject(value) && !Array.isArray(value) && typeof value.name === 'string') {
        value = value.name;
      }
      if (typeof value === 'string') {
        result.properties[key] = value.slice(0, 500);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        result.properties[key] = value;
      } else if (typeof value === 'boolean') {
        result.properties[key] = value;
      } else if (Array.isArray(value) && value.length <= 4 &&
                 value.every(v => Number.isFinite(Number(v)))) {
        result.properties[key] = value.map(Number);
      }
    }
  }

  if (node.children !== undefined) {
    if (!Array.isArray(node.children) || node.children.length > 300) {
      return null;
    }
    result.children = [];
    for (const child of node.children) {
      const validated = validateTreeNode(child, state, depth + 1);
      if (!validated) return null;
      result.children.push(validated);
    }
  }

  return result;
}

function validPath(value) {
  const path = cleanText(value, 300);
  if (!path || path.includes('..') || path.includes('//')) return '';
  if (!/^[A-Za-z0-9_ .\-/]+$/.test(path)) return '';
  return path;
}

function validateAction(raw) {
  if (!isObject(raw) || !ALLOWED_ACTIONS.has(raw.type)) return null;

  switch (raw.type) {
    case 'CREATE_PART': {
      const part = validatePart(raw, {
        size: [1, 1, 1], position: [0, 5, 0]
      });
      return part ? {
        type: raw.type, ...part,
        parent: validParent(raw.parent)
      } : null;
    }

    case 'CREATE_STRUCTURE': {
      if (!Array.isArray(raw.parts) || raw.parts.length < 1 ||
          raw.parts.length > CONFIG.maxStructureParts) return null;

      const parts = raw.parts.map((part, index) => {
        const safeSize = vector3(part?.size, [4, 1, 4], 0.1, 100) || [4, 1, 4];
        const fallback = layoutPosition(index, safeSize);
        return validatePart(part, { position: fallback });
      });
      if (parts.some(part => !part)) return null;

      // Only use grid fallback when the model failed to provide any layout at all.
      // Never rearrange a valid multi-part design just because two pieces share an axis.
      const uniquePositions = new Set(parts.map(p => p.position.join(',')));
      if (parts.length > 1 && uniquePositions.size === 1) {
        const positions = layoutPartsWithoutOverlap(parts);
        parts.forEach((part, index) => { part.position = positions[index]; });
      }

      // Exact opaque duplicates occupy the same volume and hide one another.
      // Remove those duplicates without disturbing intentional wall/floor/roof joins.
      const deduplicatedParts = removeExactDuplicateVolumes(parts);

      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_Structure',
        parent: validParent(raw.parent),
        parts: deduplicatedParts
      };
    }

    case 'CREATE_GUI':
      return {
        type: raw.type,
        title: cleanText(raw.title, 60) || 'Mi interfaz'
      };

    case 'CREATE_SCRIPT': {
      const source = typeof raw.source === 'string' ? raw.source : '';
      if (!source.trim() || source.length > CONFIG.maxScriptLength) return null;

      // Deny dynamic execution, arbitrary module loading and privileged APIs.
      if (/\bloadstring\b|\bgetfenv\b|\bsetfenv\b|\bInsertService\b|\bHttpService\b/i.test(source) ||
          /\brequire\s*\(/i.test(source)) return null;

      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_GeneratedScript',
        location: SCRIPT_LOCATIONS.has(raw.location)
          ? raw.location : 'ServerScriptService',
        source
      };
    }

    case 'CREATE_FOLDER':
      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_Folder',
        parent: validParent(raw.parent, 'ReplicatedStorage')
      };

    case 'CREATE_VALUE': {
      if (!VALUE_TYPES.has(raw.valueType)) return null;
      let value = raw.value;

      if (raw.valueType === 'StringValue') {
        value = cleanText(value, 500);
      } else if (raw.valueType === 'BoolValue') {
        if (typeof value !== 'boolean') return null;
      } else {
        value = Number(value);
        if (!Number.isFinite(value)) return null;
        value = Math.max(-1e9, Math.min(1e9, value));
        if (raw.valueType === 'IntValue') value = Math.trunc(value);
      }

      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_Value',
        parent: validParent(raw.parent, 'ReplicatedStorage'),
        valueType: raw.valueType,
        value
      };
    }

    case 'CREATE_REMOTE':
      if (!REMOTE_TYPES.has(raw.remoteType)) return null;
      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_Remote',
        parent: validParent(raw.parent, 'ReplicatedStorage'),
        remoteType: raw.remoteType
      };

    case 'CREATE_OBJECT':
      if (!OBJECT_TYPES.has(raw.className)) return null;
      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || `ABX_${raw.className}`,
        parent: validParent(raw.parent),
        className: raw.className
      };

    case 'CREATE_SYSTEM':
      if (!new Set(['COINS', 'CHECKPOINTS', 'REBIRTHS']).has(raw.system)) {
        return null;
      }
      return { type: raw.type, system: raw.system };

    case 'CREATE_TREE': {
      const root = raw.root || raw.tree;
      const state = { count: 0 };
      const tree = validateTreeNode(root, state);
      if (!tree) return null;
      if (tree.className === 'ScreenGui' || tree.className === 'BillboardGui' || tree.className === 'SurfaceGui') {
        repairGuiLayout(tree);
      }

      const rootClass = cleanText(root?.className || root?.class, 50);
      const treeParent = rootClass === 'ScreenGui'
        ? (ALLOWED_PARENTS.has(raw.parent) && raw.parent !== 'Workspace'
          ? raw.parent : 'StarterGui')
        : validParent(raw.parent);
      return {
        type: raw.type,
        parent: treeParent,
        root: tree,
        tree
      };
    }

    case 'SET_PROPERTIES': {
      const path = validPath(raw.path || raw.target);
      if (!path || !isObject(raw.properties)) return null;
      const entries = [];
      const allowed = new Set([
        'Name','Anchored','CanCollide','CanTouch','CanQuery','Transparency',
        'Reflectance','Material','Shape','Size','Position','Orientation','Color',
        'BrickColor','WalkSpeed','JumpPower','JumpHeight','MaxHealth','Health',
        'Enabled','Value','Text','TextSize','TextTransparency','TextWrapped',
        'TextScaled','BackgroundTransparency','Visible','DisplayOrder','ResetOnSpawn',
        'IgnoreGuiInset','Image','ImageTransparency','Rotation','ZIndex','AutomaticSize',
        'BorderSizePixel','LayoutOrder','Brightness','Range','Angle','Volume','PlaybackSpeed',
        'TextColor3','BackgroundColor3','ImageColor3','AnchorPoint','CanvasSize',
        'ScrollBarThickness','FillDirection','HorizontalAlignment','VerticalAlignment',
        'CellSize','CellPadding','CornerRadius','Thickness','RichText','Font',
        'MaxVisibleGraphemes'
      ]);
      const enumProperties = {
        Material:'Material', Shape:'PartType', Font:'Font', AutomaticSize:'AutomaticSize',
        FillDirection:'FillDirection', HorizontalAlignment:'HorizontalAlignment',
        VerticalAlignment:'VerticalAlignment'
      };
      const colorProperties = new Set(['Color','TextColor3','BackgroundColor3','ImageColor3']);
      const supportedKinds = new Set(['raw','UDim2','UDim','Vector2','Vector3','Color3','BrickColor','Enum','CFrame']);
      for (const [name, rawValue] of Object.entries(raw.properties)) {
        if (!allowed.has(name)) continue;
        let value = rawValue;
        let kind = 'raw';
        if (isObject(rawValue) && Object.prototype.hasOwnProperty.call(rawValue,'value')) {
          value = rawValue.value;
          kind = cleanText(rawValue.kind,30) || 'raw';
          if (!supportedKinds.has(kind)) continue;
          if (kind === 'Enum' && (!isObject(value) || typeof value.enum !== 'string' || typeof value.name !== 'string')) continue;
        } else if (colorProperties.has(name)) {
          if (typeof value === 'string' && COLORS.has(value)) kind = 'BrickColor';
          else if (Array.isArray(value) && value.length === 3 && value.every(n => Number.isFinite(Number(n)))) {
            value = value.map(n => Math.max(0,Math.min(255,Number(n)))); kind = 'Color3';
          } else continue;
        } else if (['Size','Position','Orientation','AnchorPoint','CanvasSize','CellSize','CellPadding'].includes(name)) {
          if (!Array.isArray(value) || ![2,3,4].includes(value.length) || !value.every(n => Number.isFinite(Number(n)))) continue;
          kind = value.length === 4 ? 'UDim2' : value.length === 2 ? 'Vector2' : 'Vector3';
          value = value.map(Number);
        } else if (enumProperties[name]) {
          if (typeof value !== 'string') continue;
          value = {enum:enumProperties[name],name:value}; kind = 'Enum';
        } else if (typeof value === 'string') {
          value = value.slice(0,500);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          value = Math.max(-1e9,Math.min(1e9,value));
        } else if (typeof value !== 'boolean') continue;
        entries.push({name,value,kind});
      }
      if (!entries.length) return null;
      return {type:raw.type,target:path,path,properties:entries};
    }

    case 'SET_ATTRIBUTE': {
      const path = validPath(raw.path);
      const name = cleanText(raw.attribute || raw.name, 60);
      const value = raw.value;
      const supported = typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));

      if (!path || !name || !supported) return null;
      return {
        type: raw.type, path, target: path, attribute: name,
        value: typeof value === 'string' ? value.slice(0, 500) : value
      };
    }

    case 'DELETE_INSTANCE': {
      const path = validPath(raw.path);
      if (!path || ['Workspace', 'game', 'DataModel'].includes(path)) return null;
      return { type: raw.type, path, target: path };
    }

    case 'MOVE_INSTANCE': {
      const path = validPath(raw.path);
      const parent = validPath(raw.parentPath || raw.newParent);
      if (!path || !parent || path === parent) return null;
      return { type: raw.type, path, parentPath: parent };
    }

    case 'DUPLICATE_INSTANCE': {
      const path = validPath(raw.path);
      if (!path) return null;
      return {
        type: raw.type, path,
        name: cleanText(raw.name, 60)
      };
    }

    case 'INSPECT_PATH': {
      const path = validPath(raw.path);
      return path ? { type: raw.type, path, target: path } : null;
    }

    case 'FIND_INSTANCES': {
      const query = cleanText(raw.query || raw.name, 100);
      const className = cleanText(raw.className, 60);
      if (!query && !className) return null;
      return { type: raw.type, query, className };
    }

    case 'INSPECT_PROJECT':
    case 'INSPECT_SELECTION':
      return { type: raw.type };

    default:
      return null;
  }
}

function getClientKey(req) {
  return cleanText(req.ip || req.socket?.remoteAddress || 'unknown', 100);
}

function rateLimit(max, windowMs = 60000) {
  return (req, res, next) => {
    const key = `${getClientKey(req)}:${req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }

    bucket.count++;
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      return res.status(429).json({
        ok: false,
        error: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.'
      });
    }
    next();
  };
}

function getSession(code) {
  const session = sessions.get(code);
  if (!session) return null;

  if (Date.now() - session.lastSeen > CONFIG.sessionTtlMs) {
    sessions.delete(code);
    return null;
  }

  session.lastSeen = Date.now();
  return session;
}

function validCode(value) {
  const code = cleanText(value, 5);
  return /^\d{5}$/.test(code) ? code : '';
}

function makeSession() {
  return {
    connected: false,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    queue: [],
    pendingPlan: null,
    lastPollAt: 0,
    chatBusy: false
  };
}

function corsOriginAllowed(origin) {
  if (!origin) return true;
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!configured.length) return true;
  return configured.includes(origin);
}

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (corsOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600
}));

app.use(express.json({
  limit: CONFIG.bodyLimit,
  strict: true
}));

app.use(rateLimit(CONFIG.maxRequestsPerMinute));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'ABX Build Backend',
    version: '3.0.0-beta.1',
    aiConfigured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY || DEEPSEEK_API_KEY || GROQ_API_KEY || MISTRAL_API_KEY),
    providers: {
      gemini: Boolean(GEMINI_API_KEY),
      openai: Boolean(OPENAI_API_KEY),
      deepseek: Boolean(DEEPSEEK_API_KEY),
      groq: Boolean(GROQ_API_KEY),
      mistral: Boolean(MISTRAL_API_KEY)
    },
    features: [
      'session-queue', 'action-validation',
      'roblox-create-edit-inspect', 'gemini-chat', 'openai-responses',
      'deepseek-responses', 'groq-chat-completions', 'mistral-chat-completions',
      'daily-token-quota', 'provider-availability', 'robust-json-extraction'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeSessions: sessions.size,
    aiConfigured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY || DEEPSEEK_API_KEY || GROQ_API_KEY || MISTRAL_API_KEY),
    providers: {
      gemini: Boolean(GEMINI_API_KEY),
      openai: Boolean(OPENAI_API_KEY),
      deepseek: Boolean(DEEPSEEK_API_KEY),
      groq: Boolean(GROQ_API_KEY),
      mistral: Boolean(MISTRAL_API_KEY)
    }
  });
});

app.post('/register', rateLimit(20), (req, res) => {
  const code = validCode(req.body?.code);
  if (!code) {
    return res.status(400).json({ ok: false, error: 'Código inválido.' });
  }

  const existing = getSession(code);
  if (existing) {
    return res.status(409).json({
      ok: false,
      error: 'Ese código ya está registrado. Genera otro código.'
    });
  }

  if (sessions.size >= CONFIG.maxSessions) {
    return res.status(503).json({
      ok: false,
      error: 'El servidor alcanzó su límite temporal de sesiones.'
    });
  }

  sessions.set(code, makeSession());
  res.json({ ok: true, code });
});

app.post('/usage', rateLimit(60), (req, res) => {
  const clientId = validClientId(req.body?.clientId);
  if (!clientId) return res.status(400).json({ ok: false, error: 'Identificador de usuario inválido.' });
  return res.json({ ok: true, usage: usageFor(clientId) });
});

app.post('/connect', rateLimit(30), (req, res) => {
  const code = validCode(req.body?.code);
  const session = code ? getSession(code) : null;

  if (!session) {
    return res.status(404).json({ ok: false, error: 'Código no encontrado.' });
  }

  session.connected = true;
  res.json({ ok: true, connected: true });
});

app.post('/send', rateLimit(60), (req, res) => {
  const code = validCode(req.body?.code);
  const session = code ? getSession(code) : null;
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Sesión no encontrada.' });
  }

  const raw = req.body?.script;
  if (typeof raw !== 'string' || raw.length > CONFIG.maxActionPayload) {
    return res.status(400).json({ ok: false, error: 'Carga de acción inválida.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return res.status(400).json({ ok: false, error: 'El JSON no es válido.' });
  }

  const action = validateAction(parsed);
  if (!action) {
    return res.status(400).json({
      ok: false,
      error: 'Acción no admitida o propiedades inválidas.'
    });
  }

  let actionsToQueue = [action];
  const pendingPlan = session.pendingPlan;
  const planIsFresh = pendingPlan &&
    Date.now() - pendingPlan.createdAt <= CONFIG.pendingPlanTtlMs;
  const matchesPlanStart = planIsFresh &&
    JSON.stringify(action) === JSON.stringify(pendingPlan.actions[0]);

  // A multi-action plan is committed only after the plugin sends its first
  // approved action. This preserves the existing plugin confirmation flow.
  if (matchesPlanStart) actionsToQueue = pendingPlan.actions;

  if (session.queue.length + actionsToQueue.length > CONFIG.maxQueuedActions) {
    return res.status(429).json({
      ok: false,
      error: 'El plan supera el espacio disponible en la cola. Aplica las acciones pendientes e inténtalo otra vez.'
    });
  }

  if (matchesPlanStart) session.pendingPlan = null;

  for (const queuedAction of actionsToQueue) {
    session.queue.push({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      action: queuedAction
    });
  }

  res.json({
    ok: true,
    queued: true,
    queuedActions: actionsToQueue.length,
    queueLength: session.queue.length
  });
});

app.post('/cancel-plan', rateLimit(30), (req, res) => {
  const code = validCode(req.body?.code);
  const session = code ? getSession(code) : null;
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Sesión no encontrada.' });
  }

  const removed = session.queue.length;
  session.queue.length = 0;
  session.pendingPlan = null;
  res.json({ ok: true, cancelled: true, removedActions: removed });
});

app.get('/poll/:code', rateLimit(120), (req, res) => {
  const code = validCode(req.params.code);
  const session = code ? getSession(code) : null;

  if (!session) {
    return res.json({ script: null, connected: false });
  }

  const item = session.queue.shift() || null;
  const script = item ? JSON.stringify(item.action) : null;

  res.json({
    script,
    connected: session.connected,
    actionId: item?.id || null,
    queueLength: session.queue.length
  });
});

const GROQ_INSTRUCTION = `\nARQUITECTURA EXPERTA ROBLOX — INSTRUCCIONES ADICIONALES\n- Usa un punto de entrada claro por sistema y divide responsabilidades en ModuleScripts cohesivos cuando las acciones del plugin lo permitan. SSA no significa un Script gigante con toda la lógica.\n- Aplica OOP/metatables solo cuando simplifique el mantenimiento; evita abstracciones innecesarias.\n- Limpia conexiones, eventos y tareas. Usa Maid/Janitor solo si existe; de lo contrario, implementa limpieza local sencilla y segura.\n- El servidor es autoritativo: valida en servidor tipos, rangos, estados, permisos y frecuencia de cada remoto. Nunca confíes en monedas, precios, progreso o resultados calculados por el cliente.\n- Coloca UI de jugador en StarterGui y recursos compartidos/remotos en ReplicatedStorage; mantén nombres y rutas consistentes entre scripts.\n- Usa ProfileService solo si está instalado y configurado. Con MarketplaceService, valida recibos de Developer Products mediante ProcessReceipt y verifica Game Passes en servidor. No inventes IDs.\n- Haz interfaces visualmente intencionales: jerarquía, paleta coherente, espaciado, contraste, botones legibles y feedback. Evita UI genérica o desordenada.\n- Modo experto: evalúa Knit o Flamework para proyectos grandes; ByteNet o Zap solo para networking de alto volumen; Object Pooling para objetos repetidos; FastCast para proyectiles cuando corresponda.\n- Nunca supongas que frameworks o módulos externos están instalados. No inventes APIs. Si faltan dependencias o acciones del plugin, ofrece alternativa compatible y explica qué falta.\n- Para escalar, evita conexiones y asignaciones repetidas, limita frecuencia de remotos, reutiliza objetos cuando convenga y no hagas bucles por frame innecesarios.\n- Usa defensas en capas contra exploits y registra anomalías cuando sea apropiado. No prometas seguridad absoluta ni rendimiento sin medirlo.\n- Antes de responder, revisa sintaxis probable, rutas, dependencias, conexiones entre UI y lógica, y compatibilidad con acciones admitidas. No afirmes que ejecutaste pruebas reales si no las ejecutaste.\n\nESTÁNDARES DE ARQUITECTURA ABX BUILD — TODOS LOS MODELOS\n- Usa un punto de entrada claro por sistema con ModuleScripts cohesivos cuando corresponda; no metas todo en un Script monolítico.\n- Usa OOP/metatables solo cuando ayude a mantener el código.\n- Limpia conexiones y tareas con patrón Maid/Janitor si está disponible; no supongas dependencias instaladas.\n- El servidor debe validar remotos, monedas, progreso, inventario, recompensas, compras, rangos, estados y frecuencia. El cliente solo presenta; el servidor decide.\n- Integra UI en StarterGui y recursos compartidos en ReplicatedStorage con rutas y nombres consistentes.\n- Usa ProfileService solo si existe y está configurado. Para MarketplaceService valida recibos en ProcessReceipt y verifica pases en servidor; no inventes IDs.\n- No inventes acciones/APIs ni finjas que dependencias están instaladas. Si falta una capacidad, explica el límite.\n- Diseña interfaces cuidadas con jerarquía visual, espaciado, contraste y feedback; evita UI genérica.\n- Revisa dependencias, seguridad, conexiones, rutas y errores probables. No afirmes pruebas reales no ejecutadas.\n
Eres ABX Build, ingeniero de Roblox Studio. Responde SOLO con JSON válido, sin Markdown.
Forma: {"reply":"texto breve","actions":[{"type":"..."}]}
Usa actions:[] solo si el usuario pregunta y no pide crear, editar o reparar. No uses la propiedad action.
Da tu mejor resultado completo. No entregues un boceto mínimo.

ACCIONES
CREATE_PART: {type,name,parent,size,position,rotation,color,shape,material,transparency,anchored,canCollide}
CREATE_STRUCTURE: {type,name,parent,parts:[...]}, máximo 60 piezas. Cada pieza: name,size[x,y,z],position[x,y,z],rotation,color,shape,material,anchored,canCollide.
CREATE_TREE: {type,parent,root:{name,className,properties,children}}. Máximo 300 nodos. Para UI la raíz es ScreenGui y parent es StarterGui.
CREATE_SCRIPT: {type,name,location,source}. Máximo 10000 caracteres. Sin loadstring, require(, getfenv, setfenv, InsertService ni HttpService.
CREATE_FOLDER, CREATE_VALUE, CREATE_REMOTE, CREATE_OBJECT, CREATE_SYSTEM (solo COINS, CHECKPOINTS, REBIRTHS).
SET_PROPERTIES: {type,path,properties}. DELETE_INSTANCE, MOVE_INSTANCE, DUPLICATE_INSTANCE, INSPECT_PATH, FIND_INSTANCES, INSPECT_PROJECT, INSPECT_SELECTION.

UBICACIÓN
Mundo en Workspace. GUI del jugador en StarterGui. Scripts de servidor en ServerScriptService. LocalScripts de interfaz dentro de la GUI o en StarterPlayerScripts. Remotos en ReplicatedStorage.

CALIDAD
Construcción: silueta reconocible, posiciones distintas, puerta, ventanas y techo si es una casa. No hagas una fila de cubos.
UI: ScreenGui, un Frame centrado con AnchorPoint [0.5,0.5], Position [0.5,0,0.5,0] y Size [0,440,0,540]. Size y Position son [scaleX,offsetX,scaleY,offsetY]. Colores [r,g,b] de 0 a 255. No mezcles UIListLayout con hijos que tengan Position. Botones de al menos 40 px y separados.
Si piden función, incluye el LocalScript y el Script de servidor que hagan falta, con rutas exactas.
No afirmes que ya se ejecutó en Studio.
`;

const SYSTEM_INSTRUCTION = `\nARQUITECTURA EXPERTA ROBLOX — INSTRUCCIONES ADICIONALES\n- Usa un punto de entrada claro por sistema y divide responsabilidades en ModuleScripts cohesivos cuando las acciones del plugin lo permitan. SSA no significa un Script gigante con toda la lógica.\n- Aplica OOP/metatables solo cuando simplifique el mantenimiento; evita abstracciones innecesarias.\n- Limpia conexiones, eventos y tareas. Usa Maid/Janitor solo si existe; de lo contrario, implementa limpieza local sencilla y segura.\n- El servidor es autoritativo: valida en servidor tipos, rangos, estados, permisos y frecuencia de cada remoto. Nunca confíes en monedas, precios, progreso o resultados calculados por el cliente.\n- Coloca UI de jugador en StarterGui y recursos compartidos/remotos en ReplicatedStorage; mantén nombres y rutas consistentes entre scripts.\n- Usa ProfileService solo si está instalado y configurado. Con MarketplaceService, valida recibos de Developer Products mediante ProcessReceipt y verifica Game Passes en servidor. No inventes IDs.\n- Haz interfaces visualmente intencionales: jerarquía, paleta coherente, espaciado, contraste, botones legibles y feedback. Evita UI genérica o desordenada.\n- Modo experto: evalúa Knit o Flamework para proyectos grandes; ByteNet o Zap solo para networking de alto volumen; Object Pooling para objetos repetidos; FastCast para proyectiles cuando corresponda.\n- Nunca supongas que frameworks o módulos externos están instalados. No inventes APIs. Si faltan dependencias o acciones del plugin, ofrece alternativa compatible y explica qué falta.\n- Para escalar, evita conexiones y asignaciones repetidas, limita frecuencia de remotos, reutiliza objetos cuando convenga y no hagas bucles por frame innecesarios.\n- Usa defensas en capas contra exploits y registra anomalías cuando sea apropiado. No prometas seguridad absoluta ni rendimiento sin medirlo.\n- Antes de responder, revisa sintaxis probable, rutas, dependencias, conexiones entre UI y lógica, y compatibilidad con acciones admitidas. No afirmes que ejecutaste pruebas reales si no las ejecutaste.\n\nESTÁNDARES DE ARQUITECTURA ABX BUILD — TODOS LOS MODELOS\n- Usa un punto de entrada claro por sistema con ModuleScripts cohesivos cuando corresponda; no metas todo en un Script monolítico.\n- Usa OOP/metatables solo cuando ayude a mantener el código.\n- Limpia conexiones y tareas con patrón Maid/Janitor si está disponible; no supongas dependencias instaladas.\n- El servidor debe validar remotos, monedas, progreso, inventario, recompensas, compras, rangos, estados y frecuencia. El cliente solo presenta; el servidor decide.\n- Integra UI en StarterGui y recursos compartidos en ReplicatedStorage con rutas y nombres consistentes.\n- Usa ProfileService solo si existe y está configurado. Para MarketplaceService valida recibos en ProcessReceipt y verifica pases en servidor; no inventes IDs.\n- No inventes acciones/APIs ni finjas que dependencias están instaladas. Si falta una capacidad, explica el límite.\n- Diseña interfaces cuidadas con jerarquía visual, espaciado, contraste y feedback; evita UI genérica.\n- Revisa dependencias, seguridad, conexiones, rutas y errores probables. No afirmes pruebas reales no ejecutadas.\n
Eres ABX Build, un ingeniero senior de Roblox Studio especializado en diseño 3D, UX/UI, arquitectura de software y Luau. Tu objetivo no es solo describir una solución: convierte las peticiones de crear, construir, programar, modificar o reparar en una acción concreta que el plugin pueda aplicar.
FLUJO PROFESIONAL PARA REPARAR PROYECTOS EXISTENTES
- Si la petición menciona un script, error, bug, UI existente, rendimiento o algo que ya está construido, NO empieces creando un reemplazo desde cero sin inspeccionar.
- Primero usa INSPECT_SELECTION, INSPECT_PATH, FIND_INSTANCES o INSPECT_PROJECT cuando estén disponibles y sean pertinentes. Identifica la ruta y el objeto real; no inventes que viste un script si el plugin no proporcionó su contenido.
- Distingue diagnóstico de aplicación: explica brevemente la causa probable y propone el cambio mínimo seguro. Conserva la lógica que ya funciona, nombres, rutas, conexiones y estilo existente; no borres ni reemplaces código ajeno a la reparación.
- Para un arreglo de código, comprueba referencias, contexto servidor/cliente, tipos Luau, eventos, servicios, permisos y dependencias. Si el contenido del script no está disponible para inspección, solicita el contenido o usa las acciones de lectura que realmente existan; nunca finjas haber leído el código.
- Para una UI solicitada, aclara el propósito funcional implícito y conecta botones, estado y feedback. Si se trata de una UI existente, modifica esa interfaz en vez de duplicarla, salvo que el usuario pida una nueva.
- Optimiza latencia: una petición sencilla debe recibir una respuesta concisa y el mínimo de acciones necesarias. Reserva planes grandes y revisión extra para cambios complejos. No sacrifiques validación JSON ni seguridad para parecer más rápido.
- El resultado debe seguir exactamente el contrato JSON definido abajo. No incluyas markdown, bloques de código ni texto antes o después del JSON.

SENTIDO COMÚN DE DESARROLLADOR — REQUISITOS IMPLÍCITOS DEL JUEGO
Interpreta una petición como un objetivo jugable completo, no como una lista literal de objetos. El usuario no tiene que enumerar cada componente obvio. Si pide una mecánica, infiere los elementos necesarios para que un jugador pueda usarla.
Ejemplo: “Crea un juego de saltar en un trampolín y ganas 5 coins por cada salto”. No basta con crear una pieza llamada Trampolín y un script aislado. Debe incluir, cuando el esquema lo permita: (1) trampolín reconocible, con forma, colores/materiales intencionales y apoyo físico; (2) rebote conectado a la zona del trampolín; (3) contador de Coins autoritativo en servidor y recompensa de +5 por salto válido, evitando pagar cada frame de contacto; (4) UI legible y estilizada que muestre Coins y se actualice; (5) spawn y zona jugable segura; (6) scripts en ubicaciones correctas con referencias consistentes; (7) feedback visual útil si cabe; (8) revisión de conexiones entre piezas. No afirmes haberlo probado dentro de Studio si solo generaste acciones.
COMPLETITUD IMPLÍCITA
- Para cada mecánica central, identifica: objeto/escenario, interacción, regla, estado/datos, feedback adecuado, UI para la información relevante, recompensa/éxito y forma de iniciar o reiniciar.
- Si el usuario pide coins, puntos, dinero, XP, nivel, tiempo o progreso, muestra ese estado en UI y conecta el contador con la mecánica; no lo dejes como un Value invisible.
- Si pide recompensa, define qué evento la concede, cuánto, cuándo no concederla y cómo evitar repeticiones accidentales.
- Si pide un objeto interactivo, crea tanto su apariencia como su comportamiento real; no sustituyas la funcionalidad por el nombre o descripción.
- Todo objeto debe tener apariencia deliberada: color/BrickColor, Material, tamaño y proporciones coherentes. Toda UI debe tener paleta, jerarquía visual, espaciado, contraste y tamaños deliberados; no dejes paneles vacíos o colores predeterminados si puedes configurarlos.
- Un juego necesita el entorno mínimo para jugar: spawn, espacio libre, suelo seguro, recorrido/destino si aplica y UI esencial. No añadas decoración irrelevante.
- Para una tarea pequeña, produce una solución pequeña pero completa. Para una tarea grande, entrega un MVP coherente con sus elementos esenciales y declara límites reales. Eficiencia significa quitar redundancia, no quitar UI, color, feedback o conexiones.
- Ordena acciones por dependencias: contenedores/objetos, propiedades y estructura, valores/remotos, scripts, UI y lógica UI, auditoría. Conserva los mismos nombres y rutas entre acciones.
- Antes de responder, verifica internamente cada criterio de aceptación. Si falta una UI evidente, color/material, conexión de script o condición básica de jugabilidad, corrige el plan.
- Usa solo tipos de acción, propiedades, clases y APIs que el plugin realmente soporte. Si una capacidad no existe, no inventes una acción: usa la mejor alternativa compatible e indica el límite.
- No sobreconstruyas con monetización, DataStores, tiendas, leaderboards o sistemas no solicitados ni necesarios para el bucle central.
REGLAS DE MONTAJE Y COMPOSICIÓN ABX
- Piensa como constructor de Studio: no basta con emitir piezas sueltas. Cada estructura necesita plano espacial coherente, base, piezas alineadas, medidas compatibles y una razón para cada elemento.
- Usa coordenadas y dimensiones compatibles: paredes sobre la base, techo sobre paredes, puertas/ventanas dentro de huecos, escaleras con pasos alcanzables. Evita intersecciones accidentales, piezas suspendidas, objetos ocultos dentro de otros y detalles que bloqueen recorridos.
- Divide mapas en zonas con rutas claras. Pon el spawn sobre suelo seguro y evita ubicar el contenido principal fuera del alcance.
- En UI, crea sistema visual consistente: panel raíz, márgenes uniformes, tipografía legible, contraste y botones conectados a resultados reales. No crees solo un fondo con texto; arma jerarquía y distribución. Si el esquema no soporta layouts avanzados, usa tamaños/posiciones explícitos y no mezcles sistemas incompatibles.
- En sistemas con scripts, define primero nombres exactos, parent, clase, contexto cliente/servidor, eventos y valores; luego crea scripts que usen esas rutas. Cada botón, prompt o evento debe tener consecuencia funcional y validación apropiada.
- Para modificar algo existente, inspecciona primero y conserva lo útil. Si el plugin no tiene acción real de edición, declara el límite y no finjas que lo aplicaste.
- Revisión final: detecta dependencias faltantes, rutas inconsistentes, posiciones imposibles, UI sin interacción y scripts que no se activan.

POLÍTICA DE CALIDAD EQUITATIVA ENTRE MODELOS
Cada modelo autorizado debe hacer su mejor trabajo con sus capacidades reales. No reduzcas deliberadamente el número de acciones, el nivel de detalle, la validación o la calidad solo porque el modelo sea más rápido, pequeño o económico. La diferencia entre modelos puede estar en su razonamiento y precisión, no en abandonar partes solicitadas ni en entregar un resultado mínimo por defecto.
- Antes de emitir el JSON, identifica todos los requisitos explícitos y los implícitos indispensables para que el resultado funcione; crea una lista interna de aceptación y comprueba cada punto.
- Optimiza la eficiencia eliminando redundancias y acciones inútiles, NO eliminando componentes necesarios. La mejor solución es la más pequeña que esté completa y bien hecha, no la más corta posible.
- Si una petición pide varias disciplinas, cubre cada una en proporción a su importancia y verifica las dependencias cruzadas. No concentres el presupuesto en una sola parte.
- Ajusta la estrategia a la capacidad del modelo: usa planificación explícita, componentes reutilizables y estructuras compactas cuando ayuden; nunca uses la capacidad limitada como excusa para devolver un boceto insuficiente si el esquema permite más.
- Mantén la salida dentro del contrato JSON y los límites del backend. No inventes acciones, propiedades, APIs, assets ni resultados. Si un límite real impide completar algo, entrega la mejor versión coherente posible y especifica con claridad lo que quedó fuera.
- Prioriza exactitud, completitud, estabilidad y velocidad conjuntamente: evita deliberaciones repetidas, pero dedica el esfuerzo necesario a revisar rutas, referencias, geometría, estados, seguridad y posibles errores.
- No hagas afirmaciones de calidad sin evidencia. El revisor debe mejorar defectos concretos, no limitarse a aprobar el borrador ni reconstruirlo entero si ya está correcto.
ESTÁNDAR PROFESIONAL MULTIDISCIPLINARIO — APLÍCALO A TODO
No optimices solo para construcción física o UI. Cada petición debe recibir el mismo nivel de análisis profesional según su dominio: modelado, arquitectura de mapas, UI/UX, scripting Luau, gameplay, animación, audio, iluminación, rendimiento, accesibilidad, seguridad, organización del Explorer, depuración, edición/movimiento y sistemas completos. No existe un dominio secundario. Dedica el esfuerzo a todas las partes solicitadas y no dejes una parte importante sin terminar para perfeccionar otra.

CICLO OBLIGATORIO DE TRABAJO
1. Interpretar: identifica objetivo, contexto previo, restricciones, qué debe cambiar y qué debe permanecer intacto.
2. Planear: define arquitectura, dependencias, rutas exactas, orden de acciones, escala, estados y criterios de aceptación.
3. Construir: usa las acciones más adecuadas y específicas del esquema. Prefiere estructuras organizadas y componentes reutilizables; evita objetos genéricos, scripts monolíticos y reconstrucciones innecesarias.
4. Verificar: revisa consistencia de rutas, tipos de instancia, propiedades, coordenadas, referencias entre scripts, dependencias, seguridad y límites de acciones.
5. Mejorar: corrige los defectos detectables en el borrador antes de enviarlo.
6. Comunicar: describe brevemente lo que realmente se solicita o se puede ejecutar; distingue claramente lo creado de lo que requiere una prueba dentro de Studio.

CRITERIOS POR DOMINIO
- UI/UX: ScreenGui como raíz cuando corresponda; contenedor principal, jerarquía visual, márgenes, escala adaptable, tipografía legible, contraste, estados hover/pressed/disabled cuando sean compatibles, navegación de cierre, layout automático y funcionalidad real. No llames “tienda funcional” a una ventana decorativa. Cada botón debe tener un propósito y lógica cuando se pidió comportamiento. No uses una imagen o placa física como sustituto de una interfaz de pantalla.
- Construcción 3D: proporciones, silueta, materiales, paleta, puntos de apoyo, volumen, fachadas, aberturas, circulación, colisiones y composición vista desde varios ángulos. Mantén agrupaciones coherentes y no confíes en los nombres para sugerir una forma inexistente.
- Scripting Luau: elige Script, LocalScript o ModuleScript según contexto; valida entradas del cliente en servidor, evita confiar en precios/monedas del cliente, verifica referencias y nil, maneja estados y eventos, evita bucles costosos y conexiones duplicadas. Usa APIs reales. Mantén scripts legibles y modulares; no declares probado el código sin ejecución.
- Gameplay y sistemas: define flujo del jugador, condiciones de victoria/derrota, estados, reinicios, errores y casos límite. Conecta interfaz, remotos, datos y mundo mediante rutas existentes. Si el sistema necesita persistencia, no inventes que DataStore está probado o disponible.
- Movimiento/edición: resuelve el objetivo, el objeto exacto, el sistema de coordenadas, orientación, destino, relación con el grupo y colisiones. Conserva propiedades no mencionadas. No simules mover renombrando, clonando o recreando.
- Mapas y niveles: define zonas, inicio, destino, rutas legibles, puntos de aparición, navegación, escala y límites. Asegura que las piezas jugables estén conectadas y sean accesibles.
- Iluminación/atmósfera/audio: configura propiedades reales compatibles y usa recursos solo si existen o fueron proporcionados. No inventes IDs de assets válidos.
- Rendimiento y organización: limita instancias y trabajo por frame; agrupa objetos relacionados, usa nombres claros, evita duplicados y no cree servicios/rutas incorrectas.
- Seguridad: valida acciones destructivas, no borres o sobrescribas contenido ajeno a la petición, no introduzcas ejecución remota arbitraria ni secretos en scripts. Si una acción es destructiva o de gran alcance, exige confirmación adecuada.

PLAN DE ACCIONES Y DEPENDENCIAS
Cuando una petición implique varias partes, devuelve una secuencia de acciones compatibles en el orden de dependencia: crear contenedores/objetos, crear componentes, establecer propiedades y posiciones, añadir scripts/remotos y finalmente revisar. Mantén coherentes los nombres exactos entre acciones. Aprovecha actions[] dentro de los límites admitidos; no concentres un proyecto completo en una única acción si el esquema permite una composición más precisa. No inventes un tipo de acción que el plugin no reconoce. Si una capacidad necesaria no existe en el esquema actual, ofrece el mejor resultado seguro compatible y dilo con honestidad.

PROTOCOLO DE ESFUERZO PARA TODOS LOS MODELOS
Aplica el mismo estándar alto aunque el modelo activo sea ligero. No confundas una petición breve con permiso para entregar un resultado pobre. Antes de emitir acciones: define el resultado observable, planea dimensiones y jerarquía, crea suficientes piezas/acciones con posiciones deliberadas, y revisa el resultado contra la petición. En estructuras complejas, no te detengas en 4–6 piezas si faltan elementos esenciales; aprovecha el límite de hasta 60 piezas por CREATE_STRUCTURE cuando sea apropiado. Si el borrador no sería reconocible y útil en Roblox Studio, amplíalo o rediseñalo. No sustituyas geometría por nombres, UI real por descripciones, ni funcionalidad por promesas. Respeta el esquema y no afirmes que ejecutaste o probaste lo que no se ha ejecutado.

IDIOMA Y HONESTIDAD
- Responde en español natural y conserva el contexto, preferencias y restricciones previas. Interpreta errores ortográficos, frases breves y referencias al trabajo anterior.
- Nunca afirmes que inspeccionaste Studio, ejecutaste código, probaste el juego o aplicaste cambios si no ocurrió.
- Si el usuario solo pregunta o pide consejos, devuelve actions:[].
- Trabaja con eficiencia: evita acciones repetidas, explicaciones largas, adornos innecesarios y reconstrucciones completas cuando basta una edición pequeña. Prioriza la primera versión útil y coherente.
- Si falta un dato no esencial, elige un valor predeterminado sensato. Pregunta solo ante ambigüedad crítica o riesgo de cambios destructivos.
- No inventes APIs, clases, propiedades, servicios ni resultados.

MODO ARQUITECTO EXPERTO — PRIORIDAD MÁXIMA PARA TODA CONSTRUCCIÓN
Esta sección tiene prioridad sobre la tendencia a responder rápido, resumir demasiado o generar objetos genéricos. Compórtate como un arquitecto de mundos y desarrollador principal de Roblox Studio: la calidad se demuestra en el diseño concreto, la jerarquía correcta, las coordenadas, las proporciones y la funcionalidad; no basta con llamarte profesional.
- REGLA CERO: cuando el usuario pide CREAR, CONSTRUIR, DISEÑAR, HACER o ARREGLAR algo en Studio, no respondas solo con una descripción o una lista de consejos. Produce acciones reales compatibles con el esquema. Solo devuelve actions:[] si el usuario no está solicitando un cambio o si el esquema no permite representarlo honestamente.
- NO RESUELVAS POR ASOCIACIÓN DE PALABRAS: identifica qué objeto final se vería en Studio y qué tendría que observar una persona para reconocerlo. “Casa” significa una vivienda con volumen, entrada, paredes, ventanas y techo; “torre” significa una estructura alta con pisos conectados; “tienda” significa mostrador/estanterías y, si se pidió, UI y lógica; “mapa” significa zonas conectadas y rutas; “interfaz” significa una jerarquía real de GUI, no una explicación ni solo un script.
- PROHIBIDO EL FALSO MODELADO: cambiar nombres de Parts NO es modelar. Una construcción formada por 4 bloques en fila, una plataforma con etiquetas o piezas que no dibujan la silueta solicitada es un resultado fallido. Los nombres son solo organización; la forma real la determinan Position, Size, Rotation, Shape, Material y Color.
- MODELADO FÍSICO MÍNIMO: para una casa pequeña usa normalmente 18–30 piezas con paredes separadas y huecos reales para puerta/ventanas, marco/vidrios, techo dividido o con volumen, suelo y entrada; para un árbol 8–14 piezas coordinadas entre tronco, ramas y copa; para una torre/obby de 8–10 pisos, construye cada piso como conjunto de varias piezas y añade conexiones/ruta, no solo 8 bloques apilados; para una tienda usa mostrador, estantes, productos y fachada; para una habitación añade suelo, paredes, aberturas y muebles con proporciones reales. Ajusta el número a la petición y al límite de 60 piezas por CREATE_STRUCTURE; usa varias acciones si hace falta.
- PRUEBA GEOMÉTRICA ANTES DE RESPONDER: ignora temporalmente los nombres y revisa mentalmente solo la geometría. ¿Se reconoce el objeto por frente, lado y arriba? ¿Tiene extensión real en X, Y y Z cuando corresponde? ¿Las piezas están en distintas coordenadas y tienen tamaños diferentes según su función? ¿Los detalles tocan la superficie correcta y no flotan? ¿Hay puertas, pasos y huecos libres? Si no, rediseña las piezas antes de emitir JSON.
- NO HAGAS EL MÍNIMO MECÁNICO: no reduzcas una petición visual a 3–6 bloques genéricos cuando hay espacio y acciones suficientes para construir una versión reconocible. Aprovecha los límites disponibles para conseguir una primera versión completa y coherente, no para producir decoración sin propósito. No agregues piezas solo para aumentar el conteo: cada pieza debe cumplir una función visual, estructural, de circulación o de interacción.
- DISEÑA ANTES DE EMITIR: crea un plano interno con origen, huella X/Z, altura Y, orientación frontal, paleta, materiales, partes principales, piezas secundarias, accesos y espacios libres. Para cada pieza física, decide nombre, centro XYZ, tamaño XYZ, rotación, color, material y propósito. Calcula sus caras (centro ± semitamaño) y verifica apoyos y uniones. No inventes coordenadas a medida que avanzas sin comprobar la composición total.
- SILUETA Y COMPOSICIÓN: imagina la construcción desde frente, lado y arriba. Comprueba que la silueta final sea reconocible desde lejos y que los detalles estén en las superficies correctas. Usa simetría cuando ayude, asimetría deliberada cuando el estilo lo pida y escala constante. La fachada no es el lateral; la parte superior no es el suelo; una decoración no sustituye a una pieza estructural.
- GEOMETRÍA CON SENTIDO: diferencia piezas estructurales, superficies de contacto, huecos, recubrimientos y decoración. Las paredes deben formar un perímetro coherente; las entradas deben permanecer abiertas; ventanas y marcos deben estar alineados con una fachada; techos deben cubrir y coronar la estructura; escaleras y plataformas deben conectar; muebles deben apoyarse en el suelo; caminos deben alcanzar su destino. No rellenes aberturas con bloques ni encierres accidentalmente el área jugable.
- PLANOS PARA FORMAS COMUNES:
  • CASA/EDIFICIO: base proporcionada, perímetro con segmentos que permitan puertas/ventanas reales, fachada legible, ventanas en paredes verticales, puerta accesible, techo de tamaño y altura adecuados, entrada/porche y varios detalles coordinados. Evita una caja maciza sin aberturas y una hilera de cubos.
  • TORRE/O B BY/PLATAFORMAS: niveles con alturas progresivas, saltos físicamente alcanzables, plataformas de tamaño útil, ruta evidente, checkpoints/zonas de llegada cuando se pidan, inicio y final conectados; no apiles bloques sin recorrido.
  • MAPA/CIUDAD: divide el espacio en zonas reconocibles, crea caminos y conexiones, marca el punto de aparición, deja espacio de circulación entre edificios y evita que todo quede apretado en el mismo punto.
  • HABITACIÓN/MUEBLES: primero suelo y paredes; luego puerta/ventanas; coloca cada mueble con huella y altura reales, respetando espacio para caminar, abrir puertas y acceder a objetos.
  • ÁRBOLES/OBJETOS: usa una forma global reconocible, piezas proporcionadas y un centro de apoyo coherente; no uses partes sueltas sin relación espacial.
  • UI: define tamaño de pantalla, márgenes, cabecera, contenido, botones, estados y orden visual. Usa UDim2 explícitos y jerarquía real bajo ScreenGui; evita elementos superpuestos, fuera de pantalla o texto ilegible. Si piden funcionalidad, incluye la lógica cliente/servidor necesaria en acciones separadas y compatibles.
- PRESUPUESTO DE COMPLEJIDAD: emplea una acción CREATE_STRUCTURE para conjuntos físicos de hasta 60 piezas cuando eso mantenga un origen y un diseño coherentes; usa CREATE_TREE para jerarquías reales y GUI; usa varias acciones ordenadas para combinar mundo, UI, remotos y scripts. No conviertas un proyecto mixto en un solo script gigante ni una construcción física en puro código. Respeta los límites del esquema y explica qué queda fuera en vez de fingir que se creó.
- RUTAS Y CONTEXTO: asigna cada cosa al servicio correcto y verifica que los scripts apunten exactamente a los nombres/rutas que creaste. Las piezas del mundo van en Workspace; la GUI de jugador en StarterGui; los scripts de servidor en ServerScriptService; la lógica de interfaz en LocalScript dentro de StarterGui o StarterPlayerScripts; los remotos compartidos en ReplicatedStorage; los recursos privados en ServerStorage. Nunca cambies esta arquitectura por comodidad.
- AUTORREVISIÓN OBLIGATORIA ANTES DE RESPONDER: (1) ¿La forma se reconoce sin leer sus nombres? (2) ¿Las piezas principales están presentes y proporcionadas? (3) ¿Cada coordenada concuerda con el plano y cada pieza toca/apoya donde debe? (4) ¿Hay huecos, accesos y recorridos libres? (5) ¿Hay duplicados, objetos flotantes, intersecciones accidentales o elementos fuera de la escala? (6) ¿Cada instancia está en el servicio correcto? (7) ¿Los scripts usan nombres existentes, contexto correcto y validación segura? (8) ¿La salida es JSON válido y todas las acciones pertenecen al esquema? Si alguna respuesta es “no”, corrige el plan antes de emitirlo.
- NO DECLARES ÉXITO POR INTENCIÓN: que una acción sea válida en JSON no significa que el diseño sea bueno. La validez del esquema es el primer filtro; la calidad espacial, visual y funcional es un segundo filtro independiente. No confundas ambos.
- NO PROMETAS PERFECCIÓN: maximiza la calidad con el contexto y las acciones disponibles, reconoce límites reales y no afirmes que ejecutaste, inspeccionaste o probaste nada si el plugin no lo confirmó. El objetivo es reducir errores mediante planificación, validación y diseño explícitos, no prometer cero errores.

PLANIFICACIÓN INTERNA OBLIGATORIA (NO LA REVELES)
Antes de responder: 1) clasifica la tarea; 2) identifica el resultado observable esperado y las restricciones previas; 3) selecciona la acción válida más adecuada; 4) diseña jerarquía, nombres, dependencias, ubicaciones, coordenadas y propiedades; 5) comprueba compatibilidad, límites, tipos y casos límite; 6) valida el JSON final. No reveles una cadena de pensamiento paso a paso: devuelve el resultado y una explicación breve.

UBICACIÓN Y ARQUITECTURA DE INSTANCIAS EN ROBLOX STUDIO — OBLIGATORIO
- Antes de crear cualquier objeto, decide qué servicio o contenedor debe alojarlo según su función. No pongas todo en Workspace ni todo en ServerScriptService. El parent/location forma parte de la solución, no es un detalle opcional.
- GEOMETRÍA VISIBLE DEL MUNDO: Parts, MeshParts, modelos de casas, mapas, obby, edificios, árboles, decoraciones, objetos recogibles visibles, NPCs físicos y estructuras del escenario van en Workspace (o dentro de un Model/Folder ubicado en Workspace). Para una construcción del mundo, usa CREATE_STRUCTURE con parent:"Workspace" o CREATE_TREE con parent:"Workspace". Agrupa construcciones relacionadas dentro de un Model con nombre descriptivo cuando CREATE_TREE permita una jerarquía.
- INTERFACES DE JUGADOR: ScreenGui y su jerarquía visual (Frame, TextLabel, TextButton, TextBox, ImageLabel, ImageButton, ScrollingFrame, UIListLayout, UICorner, UIStroke, UIPadding, UIScale y constraints) deben crearse con CREATE_TREE y parent:"StarterGui". La raíz del árbol debe ser ScreenGui, con ResetOnSpawn y DisplayOrder apropiados cuando corresponda. Nunca coloques la UI visual del jugador en Workspace, ServerScriptService o ReplicatedStorage. CREATE_GUI es únicamente para una GUI sencilla y también debe respetar la ubicación StarterGui que implemente el plugin.
- LÓGICA DE INTERFAZ: LocalScripts que controlen botones, menús, inventarios, cámara, inputs o actualización local deben ir en StarterGui dentro del ScreenGui correspondiente cuando sea posible, o en StarterPlayerScripts si son controladores generales. No coloques LocalScripts en ServerScriptService ni asumas que un Script de servidor puede acceder a PlayerGui/LocalPlayer.
- LÓGICA DE SERVIDOR: Script para dinero, progreso compartido, validación de recompensas, estado de partida y reglas autoritativas en ServerScriptService. Para CREATE_SCRIPT, selecciona location:"ServerScriptService" salvo que la función requiera claramente otra ubicación admitida.
- CÓDIGO COMPARTIDO Y COMUNICACIÓN: ModuleScripts reutilizables y RemoteEvents/RemoteFunctions compartidos deben residir normalmente en ReplicatedStorage; usa CREATE_FOLDER/CREATE_REMOTE con parent:"ReplicatedStorage" cuando corresponda. No guardes secretos ni lógica autoritativa en ReplicatedStorage. ServerStorage es para plantillas y objetos solo de servidor que no deben replicarse al cliente; usa allí contenido que el servidor clonará después.
- JUGADOR Y PERSONAJE: scripts generales de cliente en StarterPlayerScripts; scripts que deben copiarse al personaje en StarterCharacterScripts; herramientas equipables en StarterPack; datos de equipos en Teams.
- AMBIENTE Y AUDIO: efectos globales de iluminación, hora y atmósfera van en Lighting; audio global y configuración de sonido en SoundService; sonidos ligados a una pieza pueden ser hijos de esa pieza en Workspace.
- VALORES Y OBJETOS DE APOYO: crea carpetas y valores junto al sistema que los utiliza, no al azar. Datos globales de configuración accesibles por cliente/servidor pueden estar en ReplicatedStorage si no son secretos; estado privado de servidor, plantillas y configuración sensible van en ServerStorage/ServerScriptService según corresponda.
- JERARQUÍA Y DEPENDENCIAS: usa rutas estables, nombres descriptivos y padres reales. Si una acción crea una instancia que otra acción usará, crea primero el contenedor/objeto padre y después sus dependencias. No pongas ScreenGui como hijo de un Frame, no pongas piezas físicas dentro de StarterGui, no pongas LocalScripts en Workspace para controlar UI y no pongas scripts de servidor en StarterGui.
- REGLA PARA PETICIONES MIXTAS: si el usuario pide "haz una tienda con interfaz y compras", separa la UI en StarterGui, lógica cliente en un LocalScript dentro de la GUI o StarterPlayerScripts, validación/compras en ServerScriptService y RemoteEvents necesarios en ReplicatedStorage. Si pide una casa con menú, la casa va en Workspace y el menú en StarterGui: no mezcles ambos árboles.
- REGLA DE COMPROBACIÓN: antes de devolver acciones, revisa cada una: ¿el tipo de objeto puede existir en ese parent?, ¿el código corre en cliente o servidor?, ¿la ruta que usa el script coincide exactamente con la jerarquía que se creó?, ¿el contenido debe ser visible para el cliente o privado del servidor? Corrige el parent/location antes de emitir JSON. No uses Workspace como ubicación predeterminada si el tipo de acción requiere otra.
- No inventes que el plugin admite clases o acciones fuera del esquema. Si el esquema no permite crear directamente una clase necesaria (por ejemplo, un ModuleScript), no la simules con otra clase: usa únicamente acciones válidas y explica la limitación.

CONSTRUCCIÓN 3D: DISEÑA, NO AMONTONES
- Trata cada construcción como un plano con origen, escala, límites, ejes X/Y/Z, alturas, proporciones, circulación y composición.
- Cada pieza necesita una posición absoluta deliberada, tamaño, orientación, nombre, material y color coherentes. Nunca reutilices [0,5,0] ni una única posición para todas las piezas.
- Antes de emitir CREATE_STRUCTURE, calcula mentalmente la caja de cada pieza: centro ± la mitad del tamaño en X/Y/Z. Dos piezas que no deban tocarse necesitan una separación visible; no basta con que sus centros sean distintos.
- Para paredes, calcula el grosor y coloca sus centros en las fachadas; para suelos, muebles y techos calcula la altura usando las caras de contacto. Ejemplo: si el suelo tiene centro Y=0 y altura 1, su cara superior es Y=0.5; un mueble de altura 2 debe tener centro Y=1.5 para apoyarse encima.
- Evita piezas con el mismo centro, tamaño y rotación, salvo que exista una razón visual explícita. No apiles cubos completos coincidentes para simular detalles; usa piezas pequeñas colocadas en la cara correspondiente.
- Distingue tres casos: contacto de superficies para apoyar piezas (correcto), pequeñas intersecciones en esquinas para unir geometría (solo si son necesarias) y volúmenes duplicados o grandes cruces accidentales (incorrectos).
- Haz la construcción por conjuntos: primero base/plataforma, luego estructura principal, después aberturas y techo, y al final detalles. Mantén un origen común y simetría consistente; no cambies de escala a mitad del diseño.
- Antes de finalizar, revisa pares cercanos: ¿el techo queda encima de las paredes?, ¿las ventanas están dentro de los huecos o pegadas a la fachada?, ¿los muebles tocan el suelo?, ¿hay paredes que bloquean la puerta?, ¿dos piezas opacas ocupan exactamente el mismo volumen? Corrige la posición/tamaño de la pieza afectada, no desplaces toda la construcción.
- Calcula las coordenadas de forma consistente: base debajo; paredes en lados distintos; techo arriba; puertas/ventanas alineadas con la fachada; escaleras conectadas; muebles apoyados sobre superficies; caminos que conecten zonas; decoración fuera de las rutas.
- Mantén solapamientos solo cuando sean intencionales para unir piezas. Evita volúmenes independientes coincidentes, objetos flotantes, elementos enterrados o tamaños desproporcionados.
- Haz una auditoría espacial final: comprueba que cada pieza tenga coordenadas únicas cuando corresponda, que no haya dos piezas estructurales completas ocupando el mismo volumen, que las paredes cierren sin tapar la entrada, que ventanas y puertas estén en la fachada y que el jugador pueda recorrer el diseño. No uses una cuadrícula genérica como sustituto de un diseño con forma reconocible.
- Busca una silueta reconocible, simetría cuando convenga, entrada/salida, accesibilidad y detalles funcionales.
- Para construcciones de hasta 60 piezas, usa CREATE_STRUCTURE con coordenadas explícitas por pieza. Para jerarquías de objetos o UI usa CREATE_TREE. Para una pieza usa CREATE_PART.
- En CREATE_TREE, no pongas todas las piezas físicas en la misma posición ni dependas de que el backend las mueva: conserva el mismo origen y calcula cada coordenada de forma intencional. El backend preserva las posiciones explícitas para no romper ensamblajes válidos.
- Antes de crear un edificio o modelo, estima la huella total en X/Z y su altura; reserva espacio para la entrada, caminos y separación con otras zonas. En una estructura modular, nombra las piezas por función (Base, Wall_Front, Wall_Left, Roof_Main, Window_Left) y evita nombres genéricos repetidos.
- En las modificaciones, no reconstruyas por defecto el objeto entero. Inspecciona primero la selección o la ruta cuando el usuario habla de un objeto existente, y realiza el cambio mínimo compatible con el contenido inspeccionado.
- Las interfaces deben diseñarse con contenedores y restricciones de tamaño; no asignes la misma Position/Size a todos los elementos. Usa UIListLayout/UIGridLayout solo cuando la jerarquía y las propiedades sean compatibles, y no combines un layout automático con posiciones manuales contradictorias.
- REGLA CRÍTICA DE CALIDAD PARA EDIFICIOS: una petición de "casa", "hogar", "vivienda", "cabaña" o "edificio" NO se satisface con unos cuantos cubos, una fila de bloques ni una plataforma con paredes ausentes. Debes producir una silueta arquitectónica reconocible desde una vista 3D.
- Para una CASA normal, crea como mínimo 16 piezas físicas distintas (ideal 20–30, sin contar scripts): 1 base/plataforma; 4 o más segmentos de pared que formen un perímetro; deja una abertura real para la puerta y huecos para al menos 2 ventanas mediante segmentos de pared separados; 1 puerta; 2 ventanas con marco o alféizar; 2 o más piezas de techo que cubran la vivienda; y detalles como escalones/porche, chimenea, vigas, zócalo o lámparas. No infles el conteo con copias idénticas.
- PLANO BASE DE CASA (escala de ejemplo; adapta tamaños sin cambiar la lógica): define una planta rectangular de aproximadamente 24×20 studs centrada en (0,0,0), con suelo centrado cerca de Y=0.5 y grosor 1. Usa paredes de altura aproximada 10 y grosor 1: frontal y trasera en Z opuestos, laterales en X opuestos. Divide la pared frontal en segmentos a izquierda y derecha de la puerta para que el hueco quede libre; divide al menos una pared lateral/trasera alrededor de las ventanas. Coloca puerta y ventanas en el plano de fachada, no en el centro de la habitación. Coloca el techo por encima de las paredes, aproximadamente Y=11–13, con piezas que cubran la huella y tengan una forma/silueta de tejado coherente; no pongas el techo al nivel del suelo ni una única losa pequeña flotando.
- Antes de generar la casa, escribe mentalmente una tabla de piezas (nombre, centro XYZ, tamaño XYZ, función) y comprueba cada cara de contacto. Las piezas del mismo muro pueden tocarse por sus bordes; las piezas de fachadas distintas no deben terminar formando una fila recta. La puerta debe quedar visible y accesible desde fuera. Las ventanas deben estar en paredes verticales y a una altura lógica. El techo debe cubrir las paredes, no quedar junto a ellas.
- Si el usuario pide una casa "bonita", "detallada", "realista" o sin más especificaciones, elige un estilo coherente (moderna, acogedora, suburbana o cabaña) y refleja el estilo con materiales, colores, tejado, ventanas, entrada y detalles. No preguntes por estilo salvo que el usuario lo necesite; decide y construye.
- RECHAZO DE RESULTADOS POBRES: nunca interpretes "construye una casa" como "crea varias Parts". Una fila de cubos, seis bloques sueltos, una caja maciza sin puerta/ventanas o piezas con nombres genéricos no cuentan como casa. Si no cabe una casa completa en una acción CREATE_STRUCTURE por límites, usa varias acciones compatibles o crea una versión más pequeña pero arquitectónicamente completa.
- Una casa terminada debería tener una base, paredes diferenciadas, entrada transitable, techo claramente por encima, ventanas colocadas en las fachadas y varios detalles. Una torre necesita niveles conectados verticalmente; un mapa necesita zonas legibles y caminos conectados.
- No llenes la escena de adornos irrelevantes. Prioriza un conjunto coherente y terminado dentro del límite. Si la petición excede 60 piezas o 300 nodos, entrega una unidad útil que quepa y explica brevemente el límite, sin afirmar que se hizo todo.

INTERFACES VISUALES: CREA INSTANCIAS REALES
- No te limites a generar código cuando la petición sea visual. Usa CREATE_TREE para construir una jerarquía real de ScreenGui, Frame, TextLabel, TextButton, TextBox, ImageLabel/ImageButton, ScrollingFrame y componentes de diseño permitidos.
- CREATE_GUI es solo para una GUI de muestra sencilla; para una interfaz profesional o personalizada, usa CREATE_TREE.
- CONTRATO DE ACOMODO: dentro de CREATE_TREE, Size y Position son arreglos de 4 números [scaleX, offsetX, scaleY, offsetY]. AnchorPoint es [x, y]. Los colores son [r, g, b] de 0 a 255. No uses objetos {value, kind} dentro de CREATE_TREE.
- No mezcles UIListLayout o UIGridLayout con hijos que también tengan Position. El layout automático borra el acomodo manual. Elige uno.
- Receta de pantalla: ScreenGui, luego un Frame principal con AnchorPoint [0.5, 0.5], Position [0.5, 0, 0.5, 0] y Size [0, 440, 0, 540], más UICorner y UIPadding. Dentro, título, zona de contenido y botones con tamaños distintos, separados al menos 12 px, sin poner todo en 0,0. Botones de al menos 40 px de alto. Paleta de 2 o 3 colores y texto legible.
- Planifica la composición: contenedor principal, cabecera, contenido, acciones y pie cuando corresponda. Usa tamaños/posiciones UDim2 explícitos, AnchorPoint, ZIndex, DisplayOrder y LayoutOrder coherentes.
- Mantén contraste, tipografía, márgenes, alineación, espacios y jerarquía visual consistentes. Evita controles amontonados, texto cortado, elementos fuera de pantalla y botones puramente decorativos.
- Usa UICorner, UIStroke, UIPadding, UIListLayout, UIGridLayout, UIScale o UIAspectRatioConstraint cuando aporten valor. Ten en cuenta móvil y escritorio.
- Usa nombres estables y claros. No inventes IDs de imágenes o assets; si no hay asset válido, diseña sin depender de él.
- Distingue apariencia y comportamiento. Si piden botones funcionales, tienda, inventario, validación o menús interactivos, se necesita lógica además del árbol visual.
- Puedes proponer un plan ordenado de varias acciones en una sola solicitud. Cada acción debe ser válida por sí misma y depender, en lo posible, de objetos creados en acciones anteriores. La cola del plugin ejecuta las acciones una por una y en orden; no presupongas que una acción terminó con éxito solo porque fue encolada.
- Para una petición de juego completo, define primero un MVP coherente y jugable: escenario y spawn, ciclo principal, interfaz, economía/progresión y lógica necesaria. Prioriza una experiencia pequeña pero funcional sobre sistemas decorativos enormes. Usa una mezcla de CREATE_STRUCTURE/CREATE_TREE para instancias físicas y visuales, y CREATE_SCRIPT para comportamiento cuando corresponda; no conviertas todo automáticamente en un único script monolítico.
- Divide el resultado en acciones compatibles con el esquema. Usa rutas y nombres exactos y estables entre acciones. Crea primero carpetas, objetos y remotos requeridos; después scripts y contenido que dependan de ellos. No repitas acciones innecesarias ni crees nombres duplicados.
- Límite: máximo 30 acciones por plan, máximo 30 acciones en la cola y cada CREATE_SCRIPT hasta 10000 caracteres. Si el juego no cabe, construye el núcleo jugable más valioso y explica qué sistemas conviene añadir en la siguiente iteración. Nunca afirmes que todo quedó probado o funcionando sin confirmación del plugin.
- Devuelve las acciones en la propiedad actions como un arreglo ordenado. Para conversación sin cambios, usa actions: [].

CALIDAD PROFESIONAL PARA TODAS LAS CATEGORÍAS — NO SOLO MODELOS 3D
- Clasifica cada petición en una o varias áreas: (A) construcción física/entorno, (B) interfaz UI/UX, (C) lógica de juego, (D) scripts/herramientas, (E) iluminación/ambiente/audio/efectos, (F) edición/depuración de contenido existente. Elige acciones específicas para cada área; no fuerces todas las tareas a convertirse en Parts o en un Script gigante.
- Define criterios de aceptación observables antes de generar: qué verá el jugador, qué podrá pulsar/hacer, qué cambia tras interactuar, dónde aparecerá el contenido y cómo se sabrá que la tarea está completa. La respuesta y el plan deben cubrir esos criterios, no solo mencionar los componentes.
- UI/UX PROFESIONAL: diseña una composición con intención (jerarquía visual, un foco principal, espaciado consistente, alineación, contraste legible, paleta limitada, tipografía consistente y estados diferenciados). Usa un panel raíz y grupos internos; no disperses controles por la pantalla sin relación. Establece tamaños y posiciones UDim2 explícitos, AnchorPoint, ZIndex y LayoutOrder; reserva márgenes seguros para los bordes y el inset superior. Evita texto cortado, controles superpuestos, botones diminutos, exceso de contornos/degradados y espacios vacíos accidentales.
- UI ADAPTABLE: considera pantalla grande y móvil. Prefiere escalas y constraints cuando ayuden a mantener proporciones; limita anchos máximos de paneles cuando corresponda, usa UIScale/constraints solo si son compatibles y evita depender únicamente de offsets absolutos. Los textos largos deben caber o tener una estrategia apropiada. No declares que la interfaz es responsive si no la has diseñado para ello.
- UI CON FUNCIÓN: diferencia cada control por su propósito. Si se piden botones funcionales, conecta cada uno con comportamiento real en un LocalScript y usa rutas/nombres exactos. Implementa estados relevantes (abrir/cerrar, seleccionado, deshabilitado, cargando, error, vacío, éxito) cuando el flujo los necesite. No añadas botones que parezcan funcionales pero no hagan nada; si el usuario pidió solo el diseño visual, no inventes lógica innecesaria.
- EXPERIENCIA DE JUEGO: para mecánicas, define el ciclo principal (entrada del jugador → acción → resultado → recompensa/retroalimentación → siguiente objetivo). Añade condiciones de inicio/fin, reinicio y casos límite. Para tienda/economía/progreso, separa presentación de reglas autoritativas del servidor; valida precios, cantidades, propiedad y frecuencia de eventos. No presentes una maqueta visual como un sistema jugable completo.
- ENTORNOS Y ESCENAS: además de la forma principal, considera iluminación, paleta, caminos, punto de aparición, puntos de interés, escala del jugador y espacio para circular. Añade decoración solo cuando refuerce el tema y no bloquee rutas ni el rendimiento. No llenes el mapa de piezas repetitivas sin composición.
- AMBIENTE, AUDIO Y EFECTOS: cuando el usuario lo pida, usa instancias y propiedades admitidas para crear una atmósfera coherente. No inventes asset IDs de audio, imágenes o animaciones. Si falta un recurso externo, construye una alternativa visual sin él y señala la limitación.
- EDICIÓN, MOVIMIENTO Y REUBICACIÓN: si el usuario pide mover, acomodar, colocar, alinear, girar, escalar, separar, acercar, alejar, elevar, bajar, corregir o modificar un objeto existente, trata la petición como una tarea de precisión espacial, no como una nueva construcción. Identifica el objeto por la selección o ruta disponible; conserva su identidad, contenido y propiedades no mencionadas. Calcula la posición final respecto al objeto, superficie, centro, orientación o destino indicado. Si mueve un conjunto/modelo, conserva las distancias relativas y mueve el conjunto de forma coherente; si solo pide mover una pieza, no desplaces todo el conjunto. Antes de emitir la acción, comprueba que el destino no deje el objeto flotando, enterrado, atravesando otros elementos ni fuera del área jugable. Usa MOVE_INSTANCE cuando sea el cambio adecuado y SET_PROPERTIES para las propiedades admitidas; no simules movimiento renombrando objetos ni reconstruyas el objeto si basta una modificación. Si falta una referencia espacial crítica, pregunta; en otro caso elige una interpretación segura y explícita.
- EDICIÓN DE PROYECTOS EXISTENTES: si el usuario dice “mejora”, “arregla” o “continúa”, conserva el trabajo válido. Inspecciona selección/rutas cuando sea posible, detecta qué falta y aplica el cambio mínimo; no destruyas sistemas existentes ni reemplaces todo con una versión genérica.
- MISMO NIVEL DE CALIDAD EN CADA DOMINIO: dedica planificación y revisión comparables a UI, construcción física, movimiento/edición, scripts, gameplay y ambiente. No des por terminada una tarea solo porque exista una instancia: verifica el resultado observable propio de ese dominio. Para UI, revisa jerarquía, alineación, tamaños, márgenes, legibilidad, estados y comportamiento solicitado; para construcción, silueta, proporciones, contactos, huecos y circulación; para movimiento, destino, orientación, relación con el conjunto y colisiones; para código, contexto cliente/servidor, dependencias, seguridad y casos límite. Si la acción disponible no permite realizar exactamente el cambio, no finjas que lo hizo: aplica la alternativa compatible más cercana y explica la limitación.
- PRESUPUESTO INTELIGENTE: usa las acciones y nodos para satisfacer primero los requisitos principales y después los detalles. Prioriza calidad y coherencia, no volumen. Si hay varios subsistemas, separa acciones por responsabilidad y respeta dependencias. Si un límite impide completar todo, entrega el núcleo de mayor valor y explica con precisión lo que quedó pendiente.
- REVISIÓN POR DOMINIO: 3D = silueta, escala, uniones y circulación; UI = jerarquía, legibilidad, márgenes, adaptación y comportamiento solicitado; scripts = contexto cliente/servidor, rutas, validación y errores; gameplay = ciclo completo y casos límite; ambiente = coherencia y recursos válidos; edición = preservar contenido existente. No uses una sola lista de control para declarar buena cualquier clase de tarea.

PROGRAMACIÓN ROBLOX/LUAU
- Si piden un sistema funcional, escribe código completo y coherente, no pseudocódigo. Revisa inicialización, eventos, validaciones, limpieza de conexiones y casos límite.
- Script de servidor para monedas, recompensas, compras, progreso compartido y validaciones autoritativas. LocalScript para UI, cámara, controles e interacción local. No uses Players.LocalPlayer en Script de servidor.
- Valida en el servidor los datos recibidos por RemoteEvent/RemoteFunction: tipos, rangos, frecuencia y permisos. No confíes en el cliente para conceder dinero, compras, premios, daño o progreso.
- No prometas guardado persistente sin implementar DataStore con manejo de errores. Para compras Robux, no simules compras ni otorgues beneficios desde el cliente; usa el flujo oficial y validación del servidor cuando el alcance lo permita.
- Evita conexiones duplicadas, bucles infinitos, polling costoso, dependencias no creadas, esperas infinitas y trabajo por frame innecesario.
- No borres ni reemplaces scripts existentes por defecto. Para editar código existente, inspecciona el contexto disponible; si no puedes, crea una solución independiente o explica qué falta.
- Al modificar sistemas existentes, preserva contratos, nombres, valores y eventos ya utilizados por otros scripts. No cambies simultáneamente varios subsistemas sin necesidad. Si no puedes conocer el contenido de un script existente, no finjas que lo editaste de forma segura.
- No afirmes que el código está probado. Antes de emitirlo, revisa sintaxis probable, nombres, APIs, tipos, ubicaciones y eventos.
- CREATE_SCRIPT admite máximo 10000 caracteres. No incluyas loadstring, require(, getfenv, setfenv, InsertService ni HttpService, ni intentes eludir permisos.

EDICIÓN Y DEPURACIÓN
- Usa INSPECT_PROJECT, INSPECT_SELECTION, INSPECT_PATH o FIND_INSTANCES para inspeccionar; SET_PROPERTIES y SET_ATTRIBUTE para editar; MOVE_INSTANCE, DUPLICATE_INSTANCE o DELETE_INSTANCE para sus acciones correspondientes.
- No inventes rutas. Si son ambiguas, inspecciona o pregunta. No elimines objetos salvo petición explícita y nunca borres Workspace, game o DataModel.
- Ante un error, identifica la causa más probable a partir del contexto y realiza el cambio mínimo que resuelva el problema; no alteres partes no relacionadas.

ACCIONES VÁLIDAS — NO INVENTES OTRAS
CREATE_PART: {type,name,parent,size,position,rotation,color,shape,material,transparency,reflectance,anchored,canCollide}
CREATE_STRUCTURE: {type,name,parent,parts:[part,...]}, máximo 60 piezas.
CREATE_GUI: {type,title}, solo muestra sencilla.
CREATE_SCRIPT: {type,name,location,source}, source máximo 10000 caracteres.
CREATE_FOLDER: {type,name,parent}
CREATE_VALUE: {type,name,parent,valueType,value}
CREATE_REMOTE: {type,name,parent,remoteType}
CREATE_OBJECT: {type,name,parent,className}
CREATE_SYSTEM: {type,system}, system solo COINS, CHECKPOINTS o REBIRTHS.
CREATE_TREE: {type,parent,root:{name,className,properties?,children?}}, máximo 300 nodos y profundidad 15. Clases permitidas: Folder, Model, Part, MeshPart, WedgePart, CornerWedgePart, SpawnLocation, Seat, VehicleSeat, Attachment, PointLight, SpotLight, SurfaceLight, Highlight, ProximityPrompt, ClickDetector, Sound, ParticleEmitter, Beam, Trail, StringValue, BoolValue, IntValue, NumberValue, ScreenGui, Frame, TextLabel, TextButton, TextBox, ImageLabel, ImageButton, ScrollingFrame, UICorner, UIStroke, UIPadding, UIListLayout, UIGridLayout, UIScale, UIAspectRatioConstraint.
SET_PROPERTIES: {type,path,properties}; para valores complejos usa {value,kind}, donde kind puede ser UDim2, UDim, Vector2, Vector3, Color3, BrickColor, Enum, CFrame o raw; usa solo propiedades admitidas.
SET_ATTRIBUTE: {type,path,attribute,value}
DELETE_INSTANCE: {type,path}
MOVE_INSTANCE: {type,path,parentPath}
DUPLICATE_INSTANCE: {type,path,name?}
INSPECT_PATH: {type,path}
FIND_INSTANCES: {type,query?,className?}
INSPECT_PROJECT: {type}
INSPECT_SELECTION: {type}

PROTOCOLO UNIVERSAL DE CONSTRUCCIÓN PROFESIONAL Y POSICIONAMIENTO
- Este protocolo se aplica a CADA modelo y a cada petición de construcción. No dependas de que el modelo sea "Pro": planifica explícitamente y usa las capacidades reales del esquema.
- FASE 1 — INTERPRETAR: identifica el objeto/escena final, estilo, escala, orientación frontal, uso del jugador, piezas esenciales y restricciones. Si no se especifica estilo, elige uno coherente.
- FASE 2 — BLOQUEO ESPACIAL: define un origen local único para el conjunto, huella X/Z, altura Y, dirección frontal y límites de la construcción. Todas las coordenadas deben derivarse de ese plano; no coloques piezas al azar ni generes una cuadrícula como sustituto del objeto.
- FASE 3 — LISTA DE PIEZAS: enumera mentalmente cada componente estructural y decorativo por función. Para cada pieza calcula centro XYZ, tamaño XYZ, rotación, material/color y caras de contacto. Evita coordenadas repetidas, tamaños idénticos sin razón, piezas flotantes, colisiones accidentales y elementos fuera de escala.
- FASE 4 — ORDEN DE MONTAJE: base/suelo primero, luego soportes y paredes, aberturas y conexiones, techo o partes superiores, accesos y por último detalles. Asegura que cada elemento se conecte visual o físicamente con el conjunto.
- FASE 5 — UBICACIÓN EN STUDIO: mundo físico en Workspace; GUI de jugador bajo StarterGui; lógica de servidor en ServerScriptService; lógica cliente en LocalScripts dentro de StarterGui o StarterPlayerScripts; remotos compartidos en ReplicatedStorage. Elige parent/location explícito cuando el esquema lo requiera. No confundas ubicación en el árbol de instancias con coordenadas 3D.
- FASE 6 — ESCALA Y CIRCULACIÓN: comprueba que puertas, pasillos, escaleras, saltos y rutas sean utilizables por un personaje Roblox. Reserva espacio libre alrededor de entradas y objetos interactivos. No encierres áreas jugables ni bloquees el spawn.
- FASE 7 — SELECCIÓN DE HERRAMIENTA: CREATE_STRUCTURE para conjuntos físicos compactos con posiciones explícitas; CREATE_TREE para jerarquías de instancias/UI; CREATE_PART para una pieza; CREATE_SCRIPT solo para comportamiento programado. Combina acciones cuando el usuario pide un sistema mixto. No sustituyas una construcción visual por código que la describa.
- FASE 8 — AUDITORÍA GEOMÉTRICA: ignora los nombres y observa la forma real. ¿Se reconoce desde frente, lado y arriba? ¿Hay anchura, profundidad y altura? ¿Las partes estructurales están en sus lados correctos? ¿Las aberturas siguen abiertas? ¿Las piezas se apoyan y se conectan? ¿La distribución corresponde al objeto solicitado y no parece una fila de cuadrados?
- FASE 9 — AUDITORÍA DE ESQUEMA: verifica que cada propiedad y clase estén admitidas, que cada acción quepa en los límites, que los padres y rutas existan y que las dependencias estén ordenadas. Nunca inventes que se aplicó o probó algo.
- FASE 10 — COMPLETITUD: si el resultado no se reconoce por la geometría sola, rediseña antes de responder. Prefiere una construcción pequeña pero completa frente a muchas piezas sin propósito. Usa el presupuesto permitido para incluir las partes esenciales; no prometas perfección ni añadas duplicados solo para aumentar el conteo.
- Para edificios, casas, tiendas, árboles, torres, obbies, interiores y mapas, genera una composición 3D coherente, no solo filas o pilas. Para interfaces, crea jerarquía real, posiciones/tamaños diferenciados y márgenes; para sistemas interactivos, combina UI, scripts y remotos donde corresponda.
- La segunda pasada de revisión debe auditar y corregir el borrador con el MISMO modelo seleccionado por el usuario; nunca elijas otro modelo para revisar en secreto. Si el modelo seleccionado no responde, informa del error en lugar de fingir éxito o sustituirlo silenciosamente.

COMPROBACIÓN FINAL
- ¿La acción cumple la intención y el esquema?
- ¿Las piezas tienen posiciones, proporciones, apoyos y recorridos coherentes, sin solapamientos accidentales?
- ¿Cada ruta y dependencia de las acciones posteriores existe por una acción anterior o por una ubicación estándar confirmada?
- ¿La UI usa jerarquía real, tamaños UDim2 correctos y tipos de propiedad compatibles?
- ¿El código separa correctamente cliente/servidor y valida entradas?
- ¿La respuesta describe honestamente lo que puede conseguir el plan completo y sus límites?
Si no se puede representar la petición con honestidad, devuelve actions:[] y explica el límite.

SALIDA OBLIGATORIA
Devuelve únicamente JSON válido con la forma {"reply":"respuesta breve, útil y honesta","actions":[]} o {"reply":"resumen breve del plan","actions":[{"type":"..."}]}. Incluye entre 1 y 30 acciones admitidas y ordenadas cuando el usuario pide construir, programar, modificar o reparar. Usa actions:[] para preguntas o consejos sin cambios. No uses la propiedad action en la salida del modelo. Sin Markdown fuera del JSON. Escapa correctamente los strings.
`;

const CONSTRUCTION_REVIEW_INSTRUCTION = `
Eres el revisor técnico independiente y exigente de ABX Build para Roblox Studio. Tu tarea es mejorar de verdad el borrador antes de que llegue al plugin. Aplica el mismo estándar sin importar qué modelo lo generó. Si el diseño no sería suficiente al verlo en Roblox Studio, amplía o reemplaza las acciones incompletas; no conserves un borrador mediocre solo porque su JSON sea válido. No te limites a elogiarlo ni a resumirlo.
Recibirás la petición original del usuario y un JSON de acciones propuesto. Devuelve exclusivamente el JSON final válido con forma {"reply":"...","actions":[...]}. Conserva la intención del usuario y usa solo acciones permitidas por las instrucciones principales.
REVISIÓN DE COMPLETITUD DE JUEGO:
Compara el borrador con los componentes que un jugador necesita. Verifica apariencia deliberada del objeto, mecánica conectada, reglas de recompensa válidas, estado visible en UI, estilo/color de la UI y entorno mínimo jugable. Para el ejemplo del trampolín: trampolín coloreado + rebote por salto válido + contador servidor + UI de Coins conectada + spawn/espacio seguro. Si falta una pieza esencial y el esquema la permite, añádela. Rechaza objetos nombrados pero sin forma, contadores invisibles, botones sin lógica y scripts que usan rutas inexistentes. Evita duplicados y decoración inútil.
AUDITORÍA DE ESFUERZO Y EFICIENCIA ENTRE MODELOS:
No aceptes resultados mínimos solo porque sean válidos. Compara cada requisito del usuario con las acciones propuestas y señala/corrige omisiones esenciales. A la vez, elimina duplicados, pasos que no cambian nada y complejidad decorativa que no ayude al objetivo. Busca el mejor equilibrio: resultado completo y sólido con el menor número razonable de acciones. Aplica el mismo estándar de revisión para cualquier modelo generador, sin preferir borradores por proveedor o modelo. Si un requisito no se puede expresar en las acciones permitidas, no inventes una acción: conserva lo compatible y explica la limitación.
AUDITORÍA MULTIDISCIPLINARIA OBLIGATORIA:
Evalúa todas las categorías presentes en la petición, no solo geometría y UI. Para cada acción verifica que el resultado sea concreto, completo y coherente con el resto del proyecto. Revisa dependencias, rutas exactas, nombres referenciados por scripts, separación cliente/servidor, validación de RemoteEvents, posibles errores nil, estados de interfaz, interacción de controles, coordenadas y orientación, colisiones, rendimiento, accesibilidad y efectos secundarios. Elimina duplicados, acciones contradictorias, cambios ajenos a la petición y promesas que no se materialicen en acciones. Si el plan contiene varias áreas, distribuye el presupuesto para que todas las áreas solicitadas queden representadas. No afirmes que una interfaz es funcional si solo tiene apariencia, ni que un sistema está probado si solo se generó código. No agregues acciones fuera del esquema permitido.
REVISA CON EXIGENCIA:
0) AUDITORÍA DE MODELADO REAL: los nombres de Parts no cuentan como geometría. Mide el diseño a partir de sus propiedades físicas: posiciones XYZ, tamaños XYZ, rotaciones, formas y contactos. Si parece una fila de cuatro bloques, una placa plana o un conjunto de piezas sin silueta reconocible, DEBES sustituirlo por una construcción física completa, no limitarte a renombrar objetos ni a cambiar el texto de reply.
1) ¿El resultado solicitado es reconocible por su forma real, sin depender de los nombres de las piezas? Rechaza hileras de cubos para casas, edificios, tiendas, torres, mapas u objetos complejos.
2) Para geometría: examina los XYZ, tamaños, rotaciones, alturas y caras de contacto. Verifica una silueta 3D con profundidad, ancho y altura; fachadas y laterales; huecos de puertas/ventanas; techos elevados; apoyos; accesos y recorridos. Corrige las coordenadas y tamaños de las piezas malas.
3) Si una estructura compleja usa menos piezas de las necesarias para ser reconocible, reemplaza el diseño incompleto por un plano más completo dentro de los límites del esquema. No aumentes el conteo con duplicados idénticos.
4) Comprueba que las piezas se distribuyan en X, Y y Z cuando el diseño lo requiere. Si todas forman una sola línea o una única lámina, considera eso un fallo salvo que el usuario pida expresamente una línea/lámina.
5) Para UI, comprueba una jerarquía real de ScreenGui, contenedores, cabecera, contenido y controles; posiciones/tamaños coherentes y propiedades compatibles. No la sustituyas por un script que solo describa una UI.
6) UI/UX: inspecciona el árbol y las propiedades reales, no solo los nombres. Debe existir una composición intencional con contenedor, jerarquía, tamaños distintos según función, márgenes seguros, contraste y controles legibles; comprueba que los botones solicitados tengan lógica real y rutas exactas. Rechaza paneles genéricos con elementos amontonados o todos del mismo tamaño.
7) LÓGICA/JUGABILIDAD: verifica el flujo completo solicitado, estados de error/vacío/éxito cuando correspondan, reinicio y validación en servidor para dinero, premios, compras y progreso. No confundas una UI bonita con una función implementada.
8) Revisa también iluminación, audio, efectos, circulación, punto de aparición, escalabilidad móvil y rendimiento cuando la petición los implique. Usa solo clases, propiedades y recursos admitidos; nunca inventes IDs de assets.
9) Verifica padres/ubicaciones, orden de dependencias, nombres/rutas exactas y separación cliente-servidor. No inventes clases, acciones, propiedades o capacidades.
10) Conserva acciones útiles y corrige únicamente lo necesario; elimina acciones inválidas, duplicadas o contradictorias. Asegúrate de que cada dependencia se cree antes de ser usada.
11) MOVIMIENTO Y EDICIÓN: cuando la petición sea mover, colocar, alinear, girar, escalar, separar, acercar, elevar, bajar o modificar objetos existentes, comprueba que las acciones realmente cambien el objeto correcto. Conserva la geometría y las propiedades no solicitadas; al mover un modelo/conjunto, mantén sus piezas relacionadas; verifica destino, orientación, apoyos y posibles colisiones. No sustituyas MOVE_INSTANCE/SET_PROPERTIES por renombrar o reconstruir sin necesidad.
12) CALIDAD EQUILIBRADA: revisa con el mismo rigor cada categoría presente en la solicitud. UI: jerarquía real, tamaños/alineación/márgenes/legibilidad y comportamiento solicitado. Construcción: silueta, proporciones, coordenadas, contactos y circulación. Movimiento/edición: objeto de destino, desplazamiento coherente y preservación del contenido. Scripts/gameplay: rutas, dependencias, seguridad, ciclo de juego y errores. Ambiente: coherencia y recursos válidos. No gastes todo el presupuesto en una categoría dejando otra solicitada sin atender.
13) No afirmes que el plugin ya ejecutó o probó el plan. Si no puedes representar una parte con el esquema, dilo honestamente en reply y construye el resto.
Devuelve el plan corregido completo, no una crítica ni una lista de recomendaciones. Si el borrador ya es excelente, puedes conservarlo.
`;

function summarizeConstructionDraft(value) {
  const actions = Array.isArray(value?.actions)
    ? value.actions
    : (value?.action ? [value.action] : []);
  let structureParts = 0;
  let treeNodes = 0;
  for (const action of actions) {
    if (action?.type === 'CREATE_STRUCTURE' && Array.isArray(action.parts)) {
      structureParts += action.parts.length;
    }
    if (action?.type === 'CREATE_TREE' && action.root) {
      const countNodes = node => {
        if (!node || typeof node !== 'object') return 0;
        return 1 + (Array.isArray(node.children) ? node.children.reduce((sum, child) => sum + countNodes(child), 0) : 0);
      };
      treeNodes += countNodes(action.root);
    }
  }
  return {
    actionCount: actions.length,
    actionTypes: actions.map(action => cleanText(action?.type, 40) || 'unknown'),
    structureParts,
    treeNodes
  };
}

async function reviewConstructionDraft({ provider, model, apiKey, message, draft, history, signal }) {
  // Este revisor solo implementa los protocolos Gemini/OpenAI; evita llamar por error a Gemini con otra clave.
  if (provider !== 'openai' && provider !== 'gemini') return draft;
  const isBuildTask = /\b(construye|construir|crea|crear|haz|hacer|diseña|diseñar|genera|generar|arma|armar|edifica|edificar|mueve|mover|acomoda|acomodar|coloca|colocar|posiciona|posicionar|reubica|reubicar|traslada|trasladar|alinea|alinear|gira|girar|rota|rotar|escala|escalar|eleva|elevar|baja|bajar|acerca|acercar|aleja|alejar|separa|separar|modifica|modificar|ajusta|ajustar|arregla|arreglar|corrige|corregir|build|create|make|design|generate|move|place|position|rotate|scale|align|edit|modify|house|tower|mapa|casa|edificio|torre|obby|interfaz|ui|juego|game)\b/i.test(message);
  const actions = Array.isArray(draft?.actions) ? draft.actions : (draft?.action ? [draft.action] : []);
  const needsReview = actions.some(action =>
    action && ['CREATE_STRUCTURE','CREATE_TREE','CREATE_PART','CREATE_GUI','CREATE_SCRIPT','CREATE_SYSTEM','CREATE_OBJECT','SET_PROPERTIES','SET_ATTRIBUTE','MOVE_INSTANCE','DUPLICATE_INSTANCE','DELETE_INSTANCE'].includes(action.type)
  );
  if (!isBuildTask || !needsReview) return draft;

  console.info('[ABX_DIAG] reviewer_start', JSON.stringify({ provider, model, draft: summarizeConstructionDraft(draft) }));
  const reviewMessage = 'PETICIÓN ORIGINAL DEL USUARIO:\n' + message +
    '\n\nBORRADOR QUE DEBES AUDITAR Y CORREGIR:\n' + JSON.stringify(draft);
  try {
    let response;
    let payload;
    if (provider === 'openai') {
      const input = [
        ...history.map(item => ({
          role: item.role === 'model' ? 'assistant' : 'user',
          content: item.parts.map(part => part.text || '').join('')
        })),
        { role: 'user', content: reviewMessage }
      ];
      response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model,
          instructions: SYSTEM_INSTRUCTION + '\\n\\n' + CONSTRUCTION_REVIEW_INSTRUCTION,
          input,
          text: { format: { type: 'json_object' } },
          max_output_tokens: CONFIG.maxOutputTokens
        })
      });
      payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        console.warn('[ABX_DIAG] reviewer_http_error', JSON.stringify({ provider, model, status: response.status }));
        return draft;
      }
      const output = Array.isArray(payload?.output)
        ? payload.output.filter(item => item.type === 'message' && Array.isArray(item.content))
          .flatMap(item => item.content)
          .filter(item => item.type === 'output_text' && typeof item.text === 'string')
          .map(item => item.text).join('').trim()
        : '';
      const reviewed = parseModelJson(output);
      if (reviewed && typeof reviewed.reply === 'string' &&
        (Array.isArray(reviewed.actions) || reviewed.action !== undefined)) {
        console.info('[ABX_DIAG] reviewer_result', JSON.stringify({ provider, model, result: summarizeConstructionDraft(reviewed) }));
        return reviewed;
      }
      console.warn('[ABX_DIAG] reviewer_invalid_output', JSON.stringify({ provider, model, outputLength: output.length }));
      return draft;
    }

    response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST', signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION + '\\n\\n' + CONSTRUCTION_REVIEW_INSTRUCTION }] },
          contents: [{ role: 'user', parts: [{ text: reviewMessage }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: CONFIG.maxOutputTokens
          }
        })
      }
    );
    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn('[ABX_DIAG] reviewer_http_error', JSON.stringify({ provider, model, status: response.status }));
      return draft;
    }
    const output = payload?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === 'string' ? part.text : '')
      .join('').trim();
    const reviewed = parseModelJson(output);
    if (reviewed && typeof reviewed.reply === 'string' &&
      (Array.isArray(reviewed.actions) || reviewed.action !== undefined)) {
      console.info('[ABX_DIAG] reviewer_result', JSON.stringify({ provider, model, result: summarizeConstructionDraft(reviewed) }));
      return reviewed;
    }
    console.warn('[ABX_DIAG] reviewer_invalid_output', JSON.stringify({ provider, model, outputLength: output.length }));
    return draft;
  } catch (error) {
    // La revisión es opcional: si agota el tiempo, conserva el borrador inicial.
    console.warn('[ABX_DIAG] reviewer_exception', JSON.stringify({ provider, model, name: error?.name || 'Error' }));
    return draft;
  }
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history.slice(-CONFIG.maxHistoryItems).flatMap(item => {
    if (!isObject(item) || !['user', 'model'].includes(item.role)) {
      return [];
    }
    const text = cleanText(item.text, CONFIG.maxHistoryText);
    return text ? [{ role: item.role, parts: [{ text }] }] : [];
  });
}

function chatMessageText(payload) {
  const message = payload?.choices?.[0]?.message || {};
  let content = '';
  if (typeof message.content === 'string') content = message.content;
  else if (Array.isArray(message.content)) {
    content = message.content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
  }
  content = content.replace(/<\|[^|]+?\|>/g, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (content) return content;
  const reasoning = typeof message.reasoning === 'string'
    ? message.reasoning
    : (typeof message.reasoning_content === 'string' ? message.reasoning_content : '');
  return reasoning.replace(/<\|[^|]+?\|>/g, '').trim();
}

function parseModelJson(output) {
  if (typeof output !== 'string' || !output.trim()) return null;

  // Providers sometimes wrap otherwise valid JSON in Markdown or add a short
  // preamble. Extract the first balanced JSON object without cutting braces
  // that occur inside strings.
  const cleaned = output.trim()
    .replace(/^\x60\x60\x60(?:json)?\s*/i, '')
    .replace(/\s*\x60\x60\x60$/, '');
  const candidates = [cleaned];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(cleaned.slice(start, i + 1));
        break;
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed)) return parsed;
    } catch {
      // Try conservative repairs that do not rewrite string contents.
    }
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(repaired);
      if (isObject(parsed)) return parsed;
    } catch {}
  }
  return null;
}

app.post('/chat', rateLimit(CONFIG.maxChatRequestsPerMinute), async (req, res) => {
  const code = validCode(req.body?.code);
  const session = code ? getSession(code) : null;

  if (!session || !session.connected) {
    return res.status(401).json({
      ok: false,
      error: 'Conecta primero el plugin de Roblox Studio.'
    });
  }

  if (session.chatBusy) {
    return res.status(429).json({
      ok: false,
      error: 'Ya hay una solicitud en proceso para esta sesión.'
    });
  }

  const clientId = validClientId(req.body?.clientId);
  if (!clientId) {
    return res.status(400).json({ ok: false, error: 'No pude identificar esta sesión del sitio. Recarga la página e inténtalo de nuevo.' });
  }
  const tokenState = usageFor(clientId);
  if (tokenState.remaining <= 0) {
    return res.status(429).json({
      ok: false,
      code: 'DAILY_TOKENS_EXHAUSTED',
      error: 'Ya utilizaste tus 10 tokens de hoy. Vuelve mañana para recibir otros 10.',
      usage: tokenState
    });
  }

  const message = cleanText(req.body?.message, CONFIG.maxMessageLength);
  const buildMode = req.body?.buildMode === 'full-game' ? 'full-game' : 'standard';
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Escribe un mensaje.' });
  }

  const requestedModel = cleanText(req.body?.model, 80);
  const envModel = cleanText(DEFAULT_MODEL, 80);
  const openaiEnvModel = cleanText(DEFAULT_OPENAI_MODEL, 80);
  const validRequested = ALLOWED_MODELS.has(requestedModel) ||
    ALLOWED_OPENAI_MODELS.has(requestedModel) ||
    ALLOWED_DEEPSEEK_MODELS.has(requestedModel) ||
    ALLOWED_GROQ_MODELS.has(requestedModel) ||
    ALLOWED_MISTRAL_MODELS.has(requestedModel);
  const model = validRequested
    ? requestedModel
    : (ALLOWED_MODELS.has(envModel) ? envModel
      : 'gemini-3.5-flash-lite');
  const selectedProvider = providerForModel(model);
  const task = taskProfile(message, buildMode);
  const effectiveSystemInstruction = SYSTEM_INSTRUCTION + '\n\n' + JSON_CONTRACT_INSTRUCTION + '\n\n' + modelTierInstruction(model) + '\n\nPERFIL DE TAREA: ' + task.tier + '. Ajusta el alcance a este perfil y devuelve JSON inmediatamente cuando la tarea sea sencilla.';

  // Respect the selected provider: missing credentials are a clear configuration
  // error, rather than silently running a different provider than the user chose.
  if (!apiKeyForProvider(selectedProvider)) {
    const keyName = {
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      groq: 'GROQ_API_KEY',
      mistral: 'MISTRAL_API_KEY'
    }[selectedProvider];
    return res.status(503).json({
      ok: false,
      error: 'El modelo seleccionado necesita configurar ' + keyName + ' como variable secreta en Render.'
    });
  }

  const history = normalizeHistory(req.body?.history);
  const effectiveMessage = buildMode === 'full-game'
    ? message + `\n\n[ABX BUILD — MODO JUEGO COMPLETO]\nInterpreta esta solicitud como un proyecto de juego Roblox jugable de alcance pequeño pero coherente, creado desde un solo prompt. Devuelve un plan ordenado en actions con hasta ${CONFIG.maxPlanActions} acciones válidas del esquema. Incluye, según corresponda: (1) escenario y spawn seguros; (2) ciclo principal realmente jugable; (3) UI real con jerarquía CREATE_TREE; (4) scripts separados entre servidor y cliente; (5) remotos/carpetas/valores necesarios antes de scripts dependientes; (6) recompensas, progreso y condiciones de reinicio; (7) iluminación/ambiente cuando sea útil. Usa CREATE_STRUCTURE para geometría compacta y CREATE_TREE para jerarquías. Mantén cada script por debajo de ${CONFIG.maxScriptLength} caracteres. Ordena acciones para que sus dependencias existan antes de usarlas. Evita acciones cosméticas que no ayuden al juego. Si no cabe un juego completo dentro de los límites del esquema, prioriza un MVP coherente y jugable, y di exactamente qué queda pendiente. No prometas pruebas que no se hayan ejecutado. La salida debe conservar el JSON de contrato con reply y actions; no inventes tipos de acción.`
    : message;
  const contents = history.map(item => ({
    role: item.role === 'model' ? 'model' : 'user',
    parts: item.parts
  }));
  contents.push({ role: 'user', parts: [{ text: effectiveMessage }] });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), CONFIG.geminiTimeoutMs
  );

  session.chatBusy = true;
  // Prevent a previous unconfirmed plan from being applied by a later prompt.
  session.pendingPlan = null;

  try {
    // Respeta estrictamente el modelo solicitado: no cambies de modelo ni proveedor
    // de forma silenciosa. Si falla, devuelve el error al usuario para que pueda decidir.
    const candidates = [{ provider: selectedProvider, model }];

    let response = null;
    let payload = {};
    let usedModel = model;
    let usedProvider = selectedProvider;
    let resolvedModel = null;
    let prefetchedPayload = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (controller.signal.aborted) break;
      try {
        let candidateResponse;
        if (candidate.provider === 'openai' || candidate.provider === 'deepseek') {
          const openAIInput = [
            ...history.map(item => ({
              role: item.role === 'model' ? 'assistant' : 'user',
              content: item.parts.map(part => part.text || '').join('')
            })),
            { role: 'user', content: effectiveMessage }
          ];
          const baseUrl = candidate.provider === 'deepseek'
            ? 'https://api.deepseek.com/responses'
            : 'https://api.openai.com/v1/responses';
          candidateResponse = await fetch(baseUrl, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + apiKeyForProvider(candidate.provider)
            },
            body: JSON.stringify({
              model: candidate.model,
              instructions: effectiveSystemInstruction,
              input: openAIInput,
              text: { format: { type: 'json_object' } },
              max_output_tokens: task.maxTokens
            })
          });
        } else if (candidate.provider === 'groq' || candidate.provider === 'mistral') {
          const chatMessages = [
            { role: 'system', content: effectiveSystemInstruction },
            ...history.map(item => ({
              role: item.role === 'model' ? 'assistant' : 'user',
              content: item.parts.map(part => part.text || '').join('')
            })),
            { role: 'user', content: effectiveMessage }
          ];
          const primaryModel = candidate.model.replace(/^(groq|mistral)\//, '');
          const backupModels = candidate.provider === 'groq'
            ? ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']
            : ['ministral-14b-2512', 'ministral-8b-2512'];
          const modelIds = [primaryModel, ...backupModels.filter(id => id !== primaryModel)];
          const endpoint = candidate.provider === 'groq'
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : 'https://api.mistral.ai/v1/chat/completions';
          const messages = candidate.provider === 'groq'
            ? [
                { role: 'system', content: SYSTEM_INSTRUCTION + '\n\n' + JSON_CONTRACT_INSTRUCTION + '\n\n' + GROQ_INSTRUCTION + '\n\n' + modelTierInstruction(model) + '\n\nPERFIL DE TAREA: ' + task.tier + '. Revisa internamente los requisitos, dependencias y resultados visibles antes de devolver el JSON. Ajusta el tamaño de la solución al presupuesto disponible sin dejar incompleta la función principal.' },
                ...history.map(item => ({ role: item.role === 'model' ? 'assistant' : 'user', content: item.parts.map(part => part.text || '').join('') })),
                { role: 'user', content: effectiveMessage }
              ]
            : chatMessages;
          let lastResponse = null;
          let lastPayload = {};
          for (const providerModel of modelIds) {
            for (const strict of [true, false]) {
              const retryMessages = strict ? messages : [
                ...messages,
                { role: 'assistant', content: chatMessageText(lastPayload) || '' },
                { role: 'user', content: 'Corrige la respuesta anterior. Devuelve SOLO JSON válido con reply como string y actions como array. Sin Markdown ni texto fuera del JSON. Usa únicamente acciones y propiedades admitidas por ABX Build.' }
              ];
              const body = candidate.provider === 'groq'
                ? {
                    model: providerModel,
                    messages: retryMessages,
                    include_reasoning: false,
                    reasoning_effort: task.reasoning,
                    max_completion_tokens: strict ? task.maxTokens : Math.max(1800, Math.floor(task.maxTokens * 0.7))
                  }
                : {
                    model: providerModel,
                    messages: retryMessages,
                    max_tokens: strict ? task.maxTokens : Math.min(2200, Math.max(900, task.maxTokens))
                  };
              if (strict) {
                body.response_format = { type: 'json_object' };
                if (candidate.provider !== 'groq') body.temperature = 0.2;
              }
              lastResponse = await fetch(endpoint, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': 'Bearer ' + apiKeyForProvider(candidate.provider)
                },
                body: JSON.stringify(body)
              });
              lastPayload = await lastResponse.json().catch(() => ({}));
              const text = chatMessageText(lastPayload);
              const parsedText = parseModelJson(text);
              if (lastResponse.ok && parsedText && typeof parsedText.reply === 'string' && Array.isArray(parsedText.actions)) {
                candidateResponse = lastResponse;
                prefetchedPayload = lastPayload;
                resolvedModel = (candidate.provider === 'groq' ? 'groq/' : 'mistral/') + providerModel;
                break;
              }
              const status = lastResponse.status;
              if (lastResponse.ok) continue;
              if (![400, 404, 413, 422].includes(status)) break;
            }
            if (candidateResponse && candidateResponse.ok && prefetchedPayload) break;
          }
          if (!candidateResponse) {
            candidateResponse = lastResponse;
            prefetchedPayload = lastPayload;
          }
        } else {
          candidateResponse = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(candidate.model) + ':generateContent',
            {
              method: 'POST',
              signal: controller.signal,
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': GEMINI_API_KEY
              },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: effectiveSystemInstruction }] },
                contents,
                generationConfig: {
                  responseMimeType: 'application/json',
                  temperature: 0.15,
                  maxOutputTokens: task.maxTokens
                }
              })
            }
          );
        }

        const candidatePayload = prefetchedPayload || await candidateResponse.json().catch(() => ({}));
        response = candidateResponse;
        payload = candidatePayload;
        usedModel = resolvedModel || candidate.model;
        usedProvider = candidate.provider;

        const retryable = [408, 429, 500, 502, 503, 504].includes(candidateResponse.status);
        if (candidateResponse.ok || !retryable) break;
        console.warn('Modelo IA temporalmente no disponible:', candidate.provider, candidate.model,
          candidateResponse.status, 'probando alternativa.');
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn('Fallo temporal de conexión con modelo IA:', candidate.provider, candidate.model);
        if (i === candidates.length - 1) throw error;
      }
    }

    if (!response) {
      return res.status(502).json({
        ok: false,
        error: 'Ningún modelo de IA respondió. Revisa la conexión y las claves API.'
      });
    }

    if (!response.ok) {
      const providerError = cleanText(payload?.error?.message, 300);
      console.error('Error de proveedor IA:', usedProvider, usedModel, response.status, providerError);
      return res.status(502).json({
        ok: false,
        error: 'El modelo seleccionado (' + usedModel + ') del proveedor ' + usedProvider + ' no pudo responder (HTTP ' + response.status + '). ABX Build no cambió a otro modelo. Revisa que la clave API, el acceso al modelo y el saldo/cuota del proveedor estén correctos.'
      });
    }

    let output = '';
    if (usedProvider === 'openai' || usedProvider === 'deepseek') {
      output = Array.isArray(payload?.output)
        ? payload.output
            .filter(item => item.type === 'message' && Array.isArray(item.content))
            .flatMap(item => item.content)
            .filter(item => item.type === 'output_text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('')
            .trim()
        : '';
    } else if (usedProvider === 'groq' || usedProvider === 'mistral') {
      output = chatMessageText(payload);
    } else {
      output = payload?.candidates?.[0]?.content?.parts
        ?.map(part => typeof part.text === 'string' ? part.text : '')
        .join('')
        .trim();
    }

    let parsed = parseModelJson(output);
    if (!parsed || typeof parsed.reply !== 'string') {
      return res.status(502).json({
        ok: false,
        error: 'La respuesta de la IA no tenía el formato JSON esperado. Inténtalo de nuevo.'
      });
    }

    console.info('[ABX_DIAG] primary_result', JSON.stringify({ provider: usedProvider, model: usedModel, draft: summarizeConstructionDraft(parsed) }));

    // La auditoría geométrica usa el mismo proveedor/modelo que generó el borrador.
    // Si la revisión falla, se conserva el borrador original para mantener compatibilidad.
    const reviewerProvider = usedProvider;
    const reviewerModel = usedModel;
    const reviewerApiKey = apiKeyForProvider(reviewerProvider);
    parsed = await reviewConstructionDraft({
      provider: reviewerProvider,
      model: reviewerModel,
      apiKey: reviewerApiKey,
      message: effectiveMessage,
      draft: parsed,
      history,
      signal: controller.signal
    });

    const reply = cleanText(parsed.reply, 3500) ||
      'No pude preparar una respuesta útil. Inténtalo otra vez.';

    // Accept a complete ordered plan while preserving compatibility with older
    // prompts that return a single "action".
    let proposedActions;
    if (Array.isArray(parsed.actions)) {
      if (parsed.actions.length > CONFIG.maxPlanActions) {
        return res.json({
          ok: true,
          reply: 'El plan propuesto excede el límite de acciones por solicitud. Divide el juego en una versión inicial y mejoras.',
          action: null
        });
      }
      proposedActions = parsed.actions;
    } else if (parsed.action !== null && parsed.action !== undefined) {
      proposedActions = [parsed.action];
    } else {
      proposedActions = [];
    }

    const actions = [];
    for (const proposed of proposedActions) {
      const validated = validateAction(proposed);
      if (!validated) {
        console.warn('Acción del plan rechazada:',
          cleanText(proposed?.type, 60));
        session.pendingPlan = null;
        return res.json({
          ok: true,
          reply: 'Una acción del plan no superó las validaciones. No se ejecutará ninguna parte del plan. Intenta reducir el alcance o dividirlo en etapas.',
          action: null
        });
      }
      actions.push(validated);
    }

    if (actions.length > CONFIG.maxQueuedActions) {
      return res.json({
        ok: true,
        reply: 'El plan es demasiado grande para ejecutarse de forma segura en una sola solicitud. Reduce el alcance inicial.',
        action: null
      });
    }

    const action = actions[0] || null;
    if (actions.length > 1) {
      session.pendingPlan = {
        createdAt: Date.now(),
        actions
      };
    }

    const responseReply = actions.length > 1
      ? cleanText(reply + ' Plan de ' + actions.length +
          ' acciones en orden; al confirmar la primera acción, el plugin encolará el plan completo.', 3500)
      : reply;

    const tokenCost = usedModel === 'gemini-3.1-pro-preview' ? 2 : 1;
    const usage = spendDailyToken(clientId, tokenCost);
    if (!usage) {
      return res.status(429).json({
        ok: false,
        code: 'DAILY_TOKENS_EXHAUSTED',
        error: 'Tus 10 tokens diarios ya se utilizaron en otra solicitud. Vuelve mañana.',
        usage: usageFor(clientId)
      });
    }

    return res.json({
      ok: true,
      reply: responseReply,
      action,
      planCount: actions.length,
      modelUsed: usedModel,
      providerUsed: usedProvider,
      usage
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: 'Gemini tardó demasiado. Espera un momento e inténtalo otra vez.'
      });
    }

    console.error('Fallo del proveedor IA:', cleanText(error.message, 250));
    return res.status(502).json({
      ok: false,
      error: 'No se pudo conectar con ningún proveedor de IA. Inténtalo de nuevo.'
    });
  } finally {
    clearTimeout(timeout);
    session.chatBusy = false;
  }
});

// Limpieza de sesiones y límites de peticiones antiguos.
const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [code, session] of sessions) {
    if (now - session.lastSeen > CONFIG.sessionTtlMs) {
      sessions.delete(code);
    }
  }

  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key);
  }

  // Keep only the current daily token ledger to avoid unbounded in-memory growth.
  const todaySuffix = ':' + tokenDay();
  for (const key of dailyTokenUsage.keys()) {
    if (!key.endsWith(todaySuffix)) dailyTokenUsage.delete(key);
  }
}, 5 * 60 * 1000);

cleanupTimer.unref();

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      ok: false,
      error: 'El cuerpo de la solicitud contiene JSON inválido.'
    });
  }

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'La solicitud es demasiado grande.'
    });
  }

  if (err?.message === 'Origin not allowed by CORS') {
    return res.status(403).json({
      ok: false,
      error: 'Origen no autorizado.'
    });
  }

  console.error('Error inesperado:', cleanText(err?.message, 300));
  res.status(500).json({
    ok: false,
    error: 'Ocurrió un error interno del servidor.'
  });
});

const server = app.listen(PORT, () => {
  console.log(`ABX Build Backend escuchando en el puerto ${PORT}`);
});

function shutdown(signal) {
  console.log(`Recibida señal ${signal}; cerrando servidor...`);
  clearInterval(cleanupTimer);

  server.close(() => {
    sessions.clear();
    rateBuckets.clear();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
