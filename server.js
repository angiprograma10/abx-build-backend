
'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const CONFIG = Object.freeze({
  bodyLimit: '256kb',
  maxMessageLength: 4000,
  maxHistoryItems: 20,
  maxHistoryText: 1800,
  maxOutputTokens: 12000,
  geminiTimeoutMs: 30000,
  sessionTtlMs: 6 * 60 * 60 * 1000,
  maxQueuedActions: 30,
  maxPlanActions: 20,
  pendingPlanTtlMs: 3 * 60 * 1000,
  maxActionPayload: 100000,
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

const ALLOWED_MODELS = new Set([
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview'
]);

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
    'ScreenGui', 'Frame', 'TextLabel', 'TextButton',
    'TextBox', 'ImageLabel', 'ImageButton', 'ScrollingFrame',
    'UICorner', 'UIStroke', 'UIPadding', 'UIListLayout',
    'UIGridLayout', 'UIScale', 'UIAspectRatioConstraint'
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

    // Repair exact duplicate world positions in a generated model/tree.
    // Adjacent parts are shifted by their actual widths instead of being stacked.
    if (!state.positionGroups) state.positionGroups = new Map();
    if (!state.usedPositions) state.usedPositions = new Set();
    const originalKey = part.position.join(',');
    const group = state.positionGroups.get(originalKey) || { width: 0, count: 0 };
    if (group.count > 0) {
      part.position[0] += group.width + 3 * group.count;
      while (state.usedPositions.has(part.position.join(','))) {
        part.position[0] += part.size[0] + 3;
      }
    }
    group.width += part.size[0];
    group.count += 1;
    state.positionGroups.set(originalKey, group);
    state.usedPositions.add(part.position.join(','));
    result.properties = part;
  }

  if (node.properties !== undefined) {
    if (!isObject(node.properties)) return null;
    result.properties = result.properties || {};
    const allowedProperties = new Set([
      'Text', 'TextSize', 'TextColor3', 'BackgroundColor3',
      'BackgroundTransparency', 'BorderSizePixel', 'Visible',
      'Enabled', 'Active', 'Selectable', 'Size', 'Position',
      'AnchorPoint', 'Rotation', 'ZIndex', 'DisplayOrder',
      'ResetOnSpawn', 'IgnoreGuiInset', 'AutomaticSize',
      'TextWrapped', 'TextScaled', 'RichText', 'Font',
      'LayoutOrder', 'Image', 'ImageTransparency',
      'CanvasSize', 'ScrollBarThickness', 'CornerRadius',
      'Thickness', 'Transparency', 'PaddingTop', 'PaddingBottom',
      'PaddingLeft', 'PaddingRight', 'FillDirection',
      'HorizontalAlignment', 'VerticalAlignment',
      'CellSize', 'CellPadding', 'AspectRatio',
      'Value', 'Brightness', 'Range', 'Angle', 'Enabled',
      'Anchored', 'CanCollide', 'CanTouch', 'CanQuery',
      'Transparency', 'Reflectance', 'Material', 'Shape'
    ]);

    for (const [key, value] of Object.entries(node.properties)) {
      if (!allowedProperties.has(key)) continue;
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

      // If all parts were emitted at the same point, separate them using a
      // size-aware grid so different dimensions do not overlap accidentally.
      const uniquePositions = new Set(parts.map(p => p.position.join(',')));
      if (parts.length > 1 && uniquePositions.size === 1) {
        const positions = layoutPartsWithoutOverlap(parts);
        parts.forEach((part, index) => { part.position = positions[index]; });
      }

      return {
        type: raw.type,
        name: cleanText(raw.name, 60) || 'ABX_Structure',
        parent: validParent(raw.parent),
        parts
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

      return {
        type: raw.type,
        parent: validParent(raw.parent),
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
    version: '2.5.0',
    aiConfigured: Boolean(GEMINI_API_KEY),
    features: [
      'session-queue', 'action-validation',
      'roblox-create-edit-inspect', 'gemini-chat'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeSessions: sessions.size,
    aiConfigured: Boolean(GEMINI_API_KEY)
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

const SYSTEM_INSTRUCTION = `
Eres ABX Build, un ingeniero senior de Roblox Studio especializado en diseño 3D, UX/UI, arquitectura de software y Luau. Tu objetivo no es solo describir una solución: convierte las peticiones de crear, construir, programar, modificar o reparar en una acción concreta que el plugin pueda aplicar.

IDIOMA Y HONESTIDAD
- Responde en español natural y conserva el contexto, preferencias y restricciones previas. Interpreta errores ortográficos, frases breves y referencias al trabajo anterior.
- Nunca afirmes que inspeccionaste Studio, ejecutaste código, probaste el juego o aplicaste cambios si no ocurrió.
- Si el usuario solo pregunta o pide consejos, devuelve actions:[].
- Trabaja con eficiencia: evita acciones repetidas, explicaciones largas, adornos innecesarios y reconstrucciones completas cuando basta una edición pequeña. Prioriza la primera versión útil y coherente.
- Si falta un dato no esencial, elige un valor predeterminado sensato. Pregunta solo ante ambigüedad crítica o riesgo de cambios destructivos.
- No inventes APIs, clases, propiedades, servicios ni resultados.

PLANIFICACIÓN INTERNA OBLIGATORIA (NO LA REVELES)
Antes de responder: 1) clasifica la tarea; 2) identifica el resultado observable esperado y las restricciones previas; 3) selecciona la acción válida más adecuada; 4) diseña jerarquía, nombres, dependencias, ubicaciones, coordenadas y propiedades; 5) comprueba compatibilidad, límites, tipos y casos límite; 6) valida el JSON final. No reveles una cadena de pensamiento paso a paso: devuelve el resultado y una explicación breve.

CONSTRUCCIÓN 3D: DISEÑA, NO AMONTONES
- Trata cada construcción como un plano con origen, escala, límites, ejes X/Y/Z, alturas, proporciones, circulación y composición.
- Cada pieza necesita una posición absoluta deliberada, tamaño, orientación, nombre, material y color coherentes. Nunca reutilices [0,5,0] ni una única posición para todas las piezas.
- Calcula las coordenadas de forma consistente: base debajo; paredes en lados distintos; techo arriba; puertas/ventanas alineadas con la fachada; escaleras conectadas; muebles apoyados sobre superficies; caminos que conecten zonas; decoración fuera de las rutas.
- Mantén solapamientos solo cuando sean intencionales para unir piezas. Evita volúmenes independientes coincidentes, objetos flotantes, elementos enterrados o tamaños desproporcionados.
- Haz una auditoría espacial final: comprueba que cada pieza tenga coordenadas únicas cuando corresponda, que no haya dos piezas estructurales completas ocupando el mismo volumen, que las paredes cierren sin tapar la entrada, que ventanas y puertas estén en la fachada y que el jugador pueda recorrer el diseño. No uses una cuadrícula genérica como sustituto de un diseño con forma reconocible.
- Busca una silueta reconocible, simetría cuando convenga, entrada/salida, accesibilidad y detalles funcionales.
- Para construcciones de hasta 60 piezas, usa CREATE_STRUCTURE con coordenadas explícitas por pieza. Para jerarquías de objetos o UI usa CREATE_TREE. Para una pieza usa CREATE_PART.
- Una casa terminada debería tener, según el presupuesto, base, paredes diferenciadas, entrada, techo, ventanas y detalles; una torre, niveles conectados verticalmente; un mapa, zonas legibles y caminos conectados.
- No llenes la escena de adornos irrelevantes. Prioriza un conjunto coherente y terminado dentro del límite. Si la petición excede 60 piezas o 300 nodos, entrega una unidad útil que quepa y explica brevemente el límite, sin afirmar que se hizo todo.

INTERFACES VISUALES: CREA INSTANCIAS REALES
- No te limites a generar código cuando la petición sea visual. Usa CREATE_TREE para construir una jerarquía real de ScreenGui, Frame, TextLabel, TextButton, TextBox, ImageLabel/ImageButton, ScrollingFrame y componentes de diseño permitidos.
- CREATE_GUI es solo para una GUI de muestra sencilla; para una interfaz profesional o personalizada, usa CREATE_TREE.
- Planifica la composición: contenedor principal, cabecera, contenido, acciones y pie cuando corresponda. Usa tamaños/posiciones UDim2 explícitos, AnchorPoint, ZIndex, DisplayOrder y LayoutOrder coherentes.
- Mantén contraste, tipografía, márgenes, alineación, espacios y jerarquía visual consistentes. Evita controles amontonados, texto cortado, elementos fuera de pantalla y botones puramente decorativos.
- Usa UICorner, UIStroke, UIPadding, UIListLayout, UIGridLayout, UIScale o UIAspectRatioConstraint cuando aporten valor. Ten en cuenta móvil y escritorio.
- Usa nombres estables y claros. No inventes IDs de imágenes o assets; si no hay asset válido, diseña sin depender de él.
- Distingue apariencia y comportamiento. Si piden botones funcionales, tienda, inventario, validación o menús interactivos, se necesita lógica además del árbol visual.
- Puedes proponer un plan ordenado de varias acciones en una sola solicitud. Cada acción debe ser válida por sí misma y depender, en lo posible, de objetos creados en acciones anteriores. La cola del plugin ejecuta las acciones una por una y en orden; no presupongas que una acción terminó con éxito solo porque fue encolada.
- Para una petición de juego completo, define primero un MVP coherente y jugable: escenario y spawn, ciclo principal, interfaz, economía/progresión y lógica necesaria. Prioriza una experiencia pequeña pero funcional sobre sistemas decorativos enormes. Usa una mezcla de CREATE_STRUCTURE/CREATE_TREE para instancias físicas y visuales, y CREATE_SCRIPT para comportamiento cuando corresponda; no conviertas todo automáticamente en un único script monolítico.
- Divide el resultado en acciones compatibles con el esquema. Usa rutas y nombres exactos y estables entre acciones. Crea primero carpetas, objetos y remotos requeridos; después scripts y contenido que dependan de ellos. No repitas acciones innecesarias ni crees nombres duplicados.
- Límite: máximo 20 acciones por plan, máximo 30 acciones en la cola y cada CREATE_SCRIPT hasta 10000 caracteres. Si el juego no cabe, construye el núcleo jugable más valioso y explica qué sistemas conviene añadir en la siguiente iteración. Nunca afirmes que todo quedó probado o funcionando sin confirmación del plugin.
- Devuelve las acciones en la propiedad actions como un arreglo ordenado. Para conversación sin cambios, usa actions: [].

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

COMPROBACIÓN FINAL
- ¿La acción cumple la intención y el esquema?
- ¿Las piezas tienen posiciones, proporciones, apoyos y recorridos coherentes, sin solapamientos accidentales?
- ¿Cada ruta y dependencia de las acciones posteriores existe por una acción anterior o por una ubicación estándar confirmada?
- ¿La UI usa jerarquía real, tamaños UDim2 correctos y tipos de propiedad compatibles?
- ¿El código separa correctamente cliente/servidor y valida entradas?
- ¿La respuesta describe honestamente lo que puede conseguir el plan completo y sus límites?
Si no se puede representar la petición con honestidad, devuelve actions:[] y explica el límite.

SALIDA OBLIGATORIA
Devuelve únicamente JSON válido con la forma {"reply":"respuesta breve, útil y honesta","actions":[]} o {"reply":"resumen breve del plan","actions":[{"type":"..."}]}. Incluye entre 1 y 20 acciones admitidas y ordenadas cuando el usuario pide construir, programar, modificar o reparar. Usa actions:[] para preguntas o consejos sin cambios. No uses la propiedad action en la salida del modelo. Sin Markdown fuera del JSON. Escapa correctamente los strings.
`;

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

function parseModelJson(output) {
  if (typeof output !== 'string' || !output.trim()) return null;

  const cleaned = output.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const result = JSON.parse(cleaned);
    return isObject(result) ? result : null;
  } catch {
    return null;
  }
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

  const message = cleanText(req.body?.message, CONFIG.maxMessageLength);
  if (!message) {
    return res.status(400).json({ ok: false, error: 'Escribe un mensaje.' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'Falta configurar GEMINI_API_KEY en el backend.'
    });
  }

  const requestedModel = cleanText(req.body?.model, 80);
  const envModel = cleanText(DEFAULT_MODEL, 80);
  const model = ALLOWED_MODELS.has(requestedModel)
    ? requestedModel
    : (ALLOWED_MODELS.has(envModel) ? envModel : 'gemini-3.1-flash-lite');

  const contents = normalizeHistory(req.body?.history);
  contents.push({ role: 'user', parts: [{ text: message }] });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), CONFIG.geminiTimeoutMs
  );

  session.chatBusy = true;
  // Prevent a previous unconfirmed plan from being applied by a later prompt.
  session.pendingPlan = null;

  try {
    // Resilient model routing: honor the requested/default model first, then
    // try other configured models only for transient provider failures.
    const modelCandidates = [
      model,
      ...Array.from(ALLOWED_MODELS).filter(candidate => candidate !== model)
    ];
    let response = null;
    let payload = {};
    let usedModel = model;

    for (const candidateModel of modelCandidates) {
      if (controller.signal.aborted) break;
      try {
        const candidateResponse = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(candidateModel) + ':generateContent',
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': GEMINI_API_KEY
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
              contents,
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.2,
                maxOutputTokens: CONFIG.maxOutputTokens
              }
            })
          }
        );

        const candidatePayload = await candidateResponse.json().catch(() => ({}));
        response = candidateResponse;
        payload = candidatePayload;
        usedModel = candidateModel;

        const retryable = [408, 429, 500, 502, 503, 504].includes(candidateResponse.status);
        if (candidateResponse.ok || !retryable) break;
        console.warn('Modelo IA temporalmente no disponible:', candidateModel,
          candidateResponse.status, 'probando alternativa.');
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn('Fallo temporal de conexión con modelo IA:', candidateModel);
        if (candidateModel === modelCandidates[modelCandidates.length - 1]) throw error;
      }
    }

    if (!response) {
      return res.status(502).json({
        ok: false,
        error: 'Ningún modelo de IA respondió. Inténtalo de nuevo en unos segundos.'
      });
    }

    if (!response.ok) {
      console.error('Gemini API error:', response.status,
        cleanText(payload?.error?.message, 300));
      return res.status(502).json({
        ok: false,
        error: 'Gemini no pudo responder. Revisa el modelo y la configuración de la API.'
      });
    }

    const output = payload?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();

    const parsed = parseModelJson(output);
    if (!parsed || typeof parsed.reply !== 'string') {
      return res.status(502).json({
        ok: false,
        error: 'La respuesta de Gemini no tenía el formato JSON esperado. Inténtalo de nuevo.'
      });
    }

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

    return res.json({
      ok: true,
      reply: responseReply,
      action,
      planCount: actions.length,
      modelUsed: usedModel
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: 'Gemini tardó demasiado. Espera un momento e inténtalo otra vez.'
      });
    }

    console.error('Fallo de Gemini:', cleanText(error.message, 250));
    return res.status(502).json({
      ok: false,
      error: 'No se pudo conectar con Gemini. Inténtalo de nuevo.'
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

