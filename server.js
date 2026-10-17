
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
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';

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
const ALLOWED_OPENAI_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.4-mini'
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

    for (const [rawKey, value] of Object.entries(node.properties)) {
      const key = propertyAliases[rawKey.toLowerCase()] || rawKey;
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
    version: '2.8.0',
    aiConfigured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY),
    providers: {
      gemini: Boolean(GEMINI_API_KEY),
      openai: Boolean(OPENAI_API_KEY)
    },
    features: [
      'session-queue', 'action-validation',
      'roblox-create-edit-inspect', 'gemini-chat', 'openai-responses'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    activeSessions: sessions.size,
    aiConfigured: Boolean(GEMINI_API_KEY || OPENAI_API_KEY),
    providers: {
      gemini: Boolean(GEMINI_API_KEY),
      openai: Boolean(OPENAI_API_KEY)
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
Devuelve únicamente JSON válido con la forma {"reply":"respuesta breve, útil y honesta","actions":[]} o {"reply":"resumen breve del plan","actions":[{"type":"..."}]}. Incluye entre 1 y 20 acciones admitidas y ordenadas cuando el usuario pide construir, programar, modificar o reparar. Usa actions:[] para preguntas o consejos sin cambios. No uses la propiedad action en la salida del modelo. Sin Markdown fuera del JSON. Escapa correctamente los strings.
`;

const CONSTRUCTION_REVIEW_INSTRUCTION = `
Eres el revisor técnico independiente y exigente de ABX Build para Roblox Studio. Tu tarea es mejorar de verdad el borrador antes de que llegue al plugin. Aplica el mismo estándar sin importar qué modelo lo generó. Si el diseño no sería suficiente al verlo en Roblox Studio, amplía o reemplaza las acciones incompletas; no conserves un borrador mediocre solo porque su JSON sea válido. No te limites a elogiarlo ni a resumirlo.
Recibirás la petición original del usuario y un JSON de acciones propuesto. Devuelve exclusivamente el JSON final válido con forma {"reply":"...","actions":[...]}. Conserva la intención del usuario y usa solo acciones permitidas por las instrucciones principales.
REVISA CON EXIGENCIA:
0) AUDITORÍA DE MODELADO REAL: los nombres de Parts no cuentan como geometría. Mide el diseño a partir de sus propiedades físicas: posiciones XYZ, tamaños XYZ, rotaciones, formas y contactos. Si parece una fila de cuatro bloques, una placa plana o un conjunto de piezas sin silueta reconocible, DEBES sustituirlo por una construcción física completa, no limitarte a renombrar objetos ni a cambiar el texto de reply.
1) ¿El resultado solicitado es reconocible por su forma real, sin depender de los nombres de las piezas? Rechaza hileras de cubos para casas, edificios, tiendas, torres, mapas u objetos complejos.
2) Para geometría: examina los XYZ, tamaños, rotaciones, alturas y caras de contacto. Verifica una silueta 3D con profundidad, ancho y altura; fachadas y laterales; huecos de puertas/ventanas; techos elevados; apoyos; accesos y recorridos. Corrige las coordenadas y tamaños de las piezas malas.
3) Si una estructura compleja usa menos piezas de las necesarias para ser reconocible, reemplaza el diseño incompleto por un plano más completo dentro de los límites del esquema. No aumentes el conteo con duplicados idénticos.
4) Comprueba que las piezas se distribuyan en X, Y y Z cuando el diseño lo requiere. Si todas forman una sola línea o una única lámina, considera eso un fallo salvo que el usuario pida expresamente una línea/lámina.
5) Para UI, comprueba una jerarquía real de ScreenGui, contenedores, cabecera, contenido y controles; posiciones/tamaños coherentes y propiedades compatibles. No la sustituyas por un script que solo describa una UI.
6) Verifica padres/ubicaciones, orden de dependencias, nombres/rutas exactas y separación cliente-servidor. No inventes clases, acciones, propiedades o capacidades.
7) Conserva acciones útiles y corrige únicamente lo necesario; elimina acciones inválidas, duplicadas o contradictorias. Asegúrate de que cada dependencia se cree antes de ser usada.
8) No afirmes que el plugin ya ejecutó o probó el plan. Si no puedes representar una parte con el esquema, dilo honestamente en reply y construye el resto.
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
  const isBuildTask = /\b(construye|construir|crea|crear|haz|hacer|diseña|diseñar|genera|generar|arma|armar|edifica|edificar|build|create|make|design|generate|house|tower|mapa|casa|edificio|torre|obby|interfaz|ui|juego|game)\b/i.test(message);
  const actions = Array.isArray(draft?.actions) ? draft.actions : (draft?.action ? [draft.action] : []);
  const needsReview = actions.some(action =>
    action && ['CREATE_STRUCTURE','CREATE_TREE','CREATE_PART','CREATE_GUI','CREATE_SCRIPT','CREATE_SYSTEM','CREATE_OBJECT'].includes(action.type)
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

  const requestedModel = cleanText(req.body?.model, 80);
  const envModel = cleanText(DEFAULT_MODEL, 80);
  const openaiEnvModel = cleanText(DEFAULT_OPENAI_MODEL, 80);
  const validRequested = ALLOWED_MODELS.has(requestedModel) ||
    ALLOWED_OPENAI_MODELS.has(requestedModel);
  const model = validRequested
    ? requestedModel
    : (ALLOWED_MODELS.has(envModel) ? envModel
      : (ALLOWED_OPENAI_MODELS.has(openaiEnvModel) ? openaiEnvModel : 'gemini-3.1-flash-lite'));
  const selectedProvider = ALLOWED_OPENAI_MODELS.has(model) ? 'openai' : 'gemini';

  // Respect the selected provider: missing credentials are a clear configuration
  // error, rather than silently running a different provider than the user chose.
  if (selectedProvider === 'openai' && !OPENAI_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'Falta configurar OPENAI_API_KEY como variable secreta en Render.'
    });
  }
  if (selectedProvider === 'gemini' && !GEMINI_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: 'Falta configurar GEMINI_API_KEY en el backend.'
    });
  }

  const history = normalizeHistory(req.body?.history);
  const contents = history.map(item => ({
    role: item.role === 'model' ? 'model' : 'user',
    parts: item.parts
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });

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

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (controller.signal.aborted) break;
      try {
        let candidateResponse;
        if (candidate.provider === 'openai') {
          const openAIInput = [
            ...history.map(item => ({
              role: item.role === 'model' ? 'assistant' : 'user',
              content: item.parts.map(part => part.text || '').join('')
            })),
            { role: 'user', content: message }
          ];
          candidateResponse = await fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + OPENAI_API_KEY
            },
            body: JSON.stringify({
              model: candidate.model,
              instructions: SYSTEM_INSTRUCTION,
              input: openAIInput,
              text: { format: { type: 'json_object' } },
              max_output_tokens: CONFIG.maxOutputTokens
            })
          });
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
        }

        const candidatePayload = await candidateResponse.json().catch(() => ({}));
        response = candidateResponse;
        payload = candidatePayload;
        usedModel = candidate.model;
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
        error: usedProvider === 'openai'
          ? 'El modelo seleccionado (' + usedModel + ') no pudo responder (HTTP ' + response.status + '). ABX Build no cambió a otro modelo. Revisa el acceso al modelo, la clave y el saldo de la API.'
          : 'El modelo seleccionado (' + usedModel + ') no pudo responder (HTTP ' + response.status + '). ABX Build no cambió a otro modelo. Revisa el acceso al modelo, la cuota y la configuración de Gemini.'
      });
    }

    let output = '';
    if (usedProvider === 'openai') {
      output = Array.isArray(payload?.output)
        ? payload.output
            .filter(item => item.type === 'message' && Array.isArray(item.content))
            .flatMap(item => item.content)
            .filter(item => item.type === 'output_text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('')
            .trim()
        : '';
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
    const reviewerApiKey = reviewerProvider === 'openai' ? OPENAI_API_KEY : GEMINI_API_KEY;
    parsed = await reviewConstructionDraft({
      provider: reviewerProvider,
      model: reviewerModel,
      apiKey: reviewerApiKey,
      message,
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

    return res.json({
      ok: true,
      reply: responseReply,
      action,
      planCount: actions.length,
      modelUsed: usedModel,
      providerUsed: usedProvider
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

