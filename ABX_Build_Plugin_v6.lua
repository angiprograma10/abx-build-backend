--[[
    ABX BUILD PLUGIN v6.0
    Creador: Angiblox
    Backend: https://abx-build-backend.onrender.com

    Agente de instancias para Roblox Studio:
    - Crea árboles completos de instancias (piezas, modelos, GUIs y layouts).
    - Edita propiedades de instancias existentes.
    - Inspecciona selección y jerarquías.
    - Crea estructuras con múltiples clases físicas.
    - Conserva confirmación manual, registro y puntos de deshacer.

    IMPORTANTE: reemplaza el plugin anterior con este script.
    Las acciones nuevas deben enviarse como JSON desde el backend.
]]

local HttpService = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection = game:GetService("Selection")
local BACKEND = "https://abx-build-backend.onrender.com"
local VERSION = "6.0"

local C = {
    bg=Color3.fromRGB(13,18,32), panel=Color3.fromRGB(23,31,51), light=Color3.fromRGB(32,43,67),
    blue=Color3.fromRGB(55,130,255), orange=Color3.fromRGB(255,155,65), white=Color3.fromRGB(240,245,255),
    muted=Color3.fromRGB(155,170,195), green=Color3.fromRGB(75,210,140), red=Color3.fromRGB(255,95,105),
    border=Color3.fromRGB(52,66,94)
}
local sessionCode, pendingAction, isPolling = nil, nil, false

local toolbar = plugin:CreateToolbar("ABX Build")
local openButton = toolbar:CreateButton("ABXBuildV6", "Abrir ABX Build v6.0", "rbxassetid://4458901886")
openButton.ClickableWhenViewportHidden = true
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, true, false, 440, 700, 350, 500)
local widget = plugin:CreateDockWidgetPluginGui("ABXBuildWidgetV6", widgetInfo)
widget.Title = "ABX Build v" .. VERSION

local function ui(className, props, parent)
    local obj = Instance.new(className)
    for k,v in pairs(props or {}) do obj[k] = v end
    obj.Parent = parent
    return obj
end
local function corner(obj, radius)
    ui("UICorner", {CornerRadius=UDim.new(0,radius or 10)}, obj)
end
local function stroke(obj, color)
    ui("UIStroke", {Color=color or C.border, Thickness=1, Transparency=.15}, obj)
end
local function label(parent, text, size, pos, textSize, color, font)
    return ui("TextLabel", {BackgroundTransparency=1, Size=size, Position=pos, Text=text,
        TextColor3=color or C.white, TextSize=textSize or 14, Font=font or Enum.Font.Gotham,
        TextXAlignment=Enum.TextXAlignment.Left, TextYAlignment=Enum.TextYAlignment.Center, TextWrapped=true}, parent)
end
local function button(parent, text, size, pos, color)
    local b=ui("TextButton", {Size=size, Position=pos, BackgroundColor3=color or C.blue, Text=text,
        TextColor3=C.white, TextSize=13, Font=Enum.Font.GothamBold, AutoButtonColor=true, BorderSizePixel=0}, parent)
    corner(b,9); return b
end

local root=ui("Frame",{Size=UDim2.fromScale(1,1),BackgroundColor3=C.bg,BorderSizePixel=0},widget)
local header=ui("Frame",{Size=UDim2.new(1,-24,0,65),Position=UDim2.fromOffset(12,12),BackgroundColor3=C.panel,BorderSizePixel=0},root)
corner(header,14); stroke(header)
ui("Frame",{Size=UDim2.new(0,4,1,-20),Position=UDim2.fromOffset(0,10),BackgroundColor3=C.orange,BorderSizePixel=0},header)
label(header,"ABX BUILD",UDim2.new(1,-95,0,30),UDim2.fromOffset(16,5),21,C.white,Enum.Font.GothamBlack)
label(header,"Agente de construcción para Studio",UDim2.new(1,-95,0,20),UDim2.fromOffset(17,35),11,C.muted)
local version=label(header,"V"..VERSION,UDim2.fromOffset(55,28),UDim2.new(1,-68,0,18),12,C.orange,Enum.Font.GothamBold)
version.TextXAlignment=Enum.TextXAlignment.Center; version.BackgroundTransparency=0; version.BackgroundColor3=Color3.fromRGB(65,44,31); corner(version,8)
local connection=ui("Frame",{Size=UDim2.new(1,-24,0,128),Position=UDim2.fromOffset(12,87),BackgroundColor3=C.panel,BorderSizePixel=0},root)
corner(connection,14); stroke(connection)
label(connection,"CONEXIÓN CON ABX BUILD WEB",UDim2.new(1,-24,0,20),UDim2.fromOffset(12,8),11,C.muted,Enum.Font.GothamBold)
local dot=ui("Frame",{Size=UDim2.fromOffset(10,10),Position=UDim2.fromOffset(13,37),BackgroundColor3=C.orange,BorderSizePixel=0},connection); corner(dot,10)
local status=label(connection,"Estado: desconectado",UDim2.new(1,-38,0,23),UDim2.fromOffset(29,31),12,C.white,Enum.Font.GothamBold)
local codeLabel=label(connection,"Código: —",UDim2.new(1,-24,0,20),UDim2.fromOffset(12,57),13,C.orange,Enum.Font.GothamBold)
local generateButton=button(connection,"Generar código",UDim2.fromOffset(140,30),UDim2.fromOffset(12,87),C.blue)
local checkButton=button(connection,"Comprobar",UDim2.fromOffset(112,30),UDim2.fromOffset(160,87),C.light); stroke(checkButton)
label(root,"VISTA PREVIA DE LA ACCIÓN",UDim2.new(1,-24,0,22),UDim2.fromOffset(14,223),12,C.muted,Enum.Font.GothamBold)
local previewCard=ui("Frame",{Size=UDim2.new(1,-24,0,225),Position=UDim2.fromOffset(12,249),BackgroundColor3=C.panel,BorderSizePixel=0},root)
corner(previewCard,14); stroke(previewCard)
label(previewCard,"Acción recibida desde la página web",UDim2.new(1,-24,0,25),UDim2.fromOffset(12,7),12,C.white,Enum.Font.GothamBold)
local preview=ui("TextBox",{Size=UDim2.new(1,-24,1,-45),Position=UDim2.fromOffset(12,36),BackgroundColor3=Color3.fromRGB(9,13,24),TextColor3=Color3.fromRGB(200,220,255),PlaceholderColor3=C.muted,PlaceholderText="Esperando una acción...",Text="",TextSize=12,Font=Enum.Font.Code,TextXAlignment=Enum.TextXAlignment.Left,TextYAlignment=Enum.TextYAlignment.Top,TextWrapped=false,ClearTextOnFocus=false,MultiLine=true},previewCard)
corner(preview,8); stroke(preview)
local applyButton=button(root,"✓  Confirmar y aplicar acción",UDim2.new(1,-24,0,42),UDim2.fromOffset(12,486),C.orange)
applyButton.TextColor3=Color3.fromRGB(35,27,19); applyButton.Visible=false
local logCard=ui("Frame",{Size=UDim2.new(1,-24,0,88),Position=UDim2.fromOffset(12,538),BackgroundColor3=C.panel,BorderSizePixel=0},root)
corner(logCard,12); stroke(logCard)
label(logCard,"ESTADO DEL PLUGIN",UDim2.new(1,-24,0,20),UDim2.fromOffset(12,5),10,C.muted,Enum.Font.GothamBold)
local logLabel=label(logCard,"ABX Build v"..VERSION.." listo.",UDim2.new(1,-24,1,-29),UDim2.fromOffset(12,25),12,C.white)
logLabel.TextYAlignment=Enum.TextYAlignment.Top
label(root,"Revisa las acciones antes de aplicarlas.",UDim2.new(1,-24,0,25),UDim2.new(0,12,1,-31),10,C.muted)

local function setLog(msg,color) logLabel.Text=tostring(msg); logLabel.TextColor3=color or C.white end
local function setStatus(connected,msg)
    status.Text=connected and "Estado: conectado" or "Estado: desconectado"
    status.TextColor3=connected and C.green or C.white; dot.BackgroundColor3=connected and C.green or C.orange
    if msg then setLog(msg,connected and C.green or C.orange) end
end
local function request(method,path,body)
    local opts={Url=BACKEND..path,Method=method,Headers={ ["Content-Type"]="application/json" }}
    if body then opts.Body=HttpService:JSONEncode(body) end
    local response=HttpService:RequestAsync(opts)
    if not response.Success then error("HTTP "..tostring(response.StatusCode)..": "..tostring(response.StatusMessage)) end
    if response.Body=="" then return {} end
    return HttpService:JSONDecode(response.Body)
end

local function containers()
    local sp=game:GetService("StarterPlayer")
    return {
        Workspace=workspace, ReplicatedStorage=game:GetService("ReplicatedStorage"), ServerStorage=game:GetService("ServerStorage"),
        ServerScriptService=game:GetService("ServerScriptService"), StarterGui=game:GetService("StarterGui"), StarterPack=game:GetService("StarterPack"),
        StarterPlayer=sp, StarterPlayerScripts=sp:WaitForChild("StarterPlayerScripts"), StarterCharacterScripts=sp:WaitForChild("StarterCharacterScripts"),
        Lighting=game:GetService("Lighting"), SoundService=game:GetService("SoundService"), Teams=game:GetService("Teams"), ReplicatedFirst=game:GetService("ReplicatedFirst")
    }
end
local function safeName(name,fallback)
    if type(name)~="string" or name:gsub("%s","")=="" then return fallback end
    return name:sub(1,80)
end
local function resolveParent(path, fallback)
    local roots=containers(); if type(path)~="string" or path=="" then return roots[fallback or "Workspace"] end
    local parts=string.split(path,"."); local current=roots[parts[1]]
    if not current then error("Contenedor raíz no permitido: "..parts[1]) end
    for i=2,#parts do
        current=current:FindFirstChild(parts[i])
        if not current then error("No se encontró la ruta: "..path) end
    end
    return current
end

-- Conversión de valores JSON a tipos Roblox. Los enums se limitan al enum y nombre indicados.
local function convert(value, kind)
    if kind==nil or kind=="raw" then return value end
    if kind=="UDim2" then return UDim2.new(value[1] or 0,value[2] or 0,value[3] or 0,value[4] or 0) end
    if kind=="UDim" then return UDim.new(value[1] or 0,value[2] or 0) end
    if kind=="Vector2" then return Vector2.new(value[1] or 0,value[2] or 0) end
    if kind=="Vector3" then return Vector3.new(value[1] or 0,value[2] or 0,value[3] or 0) end
    if kind=="Color3" then
        if value.r then return Color3.new(value.r,value.g,value.b) end
        return Color3.fromRGB(value[1] or 255,value[2] or 255,value[3] or 255)
    end
    if kind=="BrickColor" then return BrickColor.new(tostring(value)) end
    if kind=="Enum" then
        if type(value)~="table" or type(value.enum)~="string" or type(value.name)~="string" then error("Enum requiere {enum, name}") end
        local enumType=Enum[value.enum]; if not enumType then error("Enum desconocido: "..value.enum) end
        local item=enumType[value.name]; if not item then error("Valor enum desconocido: "..value.name) end
        return item
    end
    if kind=="CFrame" then
        if #value==3 then return CFrame.new(value[1],value[2],value[3]) end
        if #value==12 then return CFrame.new(table.unpack(value)) end
    end
    error("Tipo de propiedad no compatible: "..tostring(kind))
end

-- Clases admitidas por creación genérica. No permite crear scripts arbitrarios mediante CREATE_TREE.
local allowedClasses={
    Folder=true,Model=true,Part=true,MeshPart=true,WedgePart=true,CornerWedgePart=true,TrussPart=true,SpawnLocation=true,Seat=true,VehicleSeat=true,
    Attachment=true,PointLight=true,SpotLight=true,SurfaceLight=true,Highlight=true,Smoke=true,Fire=true,Sparkles=true,ClickDetector=true,ProximityPrompt=true,
    WeldConstraint=true,Motor6D=true,Animation=true,Sound=true,ParticleEmitter=true,Beam=true,Trail=true,
    ScreenGui=true, BillboardGui=true,SurfaceGui=true,Frame=true,ScrollingFrame=true,ViewportFrame=true,TextLabel=true,TextButton=true,TextBox=true,
    ImageLabel=true,ImageButton=true,VideoFrame=true,CanvasGroup=true,UIListLayout=true,UIGridLayout=true,UITableLayout=true,UIPageLayout=true,
    UIPadding=true,UICorner=true,UIStroke=true,UIGradient=true,UIScale=true,UITextSizeConstraint=true,UIAspectRatioConstraint=true,
    StringValue=true,BoolValue=true,IntValue=true,NumberValue=true,ObjectValue=true,Color3Value=true,Vector3Value=true,CFrameValue=true,
    RemoteEvent=true,RemoteFunction=true,BindableEvent=true,BindableFunction=true,Configuration=true,Team=true,Atmosphere=true, Sky=true,
    BloomEffect=true,BlurEffect=true,ColorCorrectionEffect=true,DepthOfFieldEffect=true,SunRaysEffect=true
}
local function setProperties(obj, props)
    if type(props)~="table" then return end
    for _,entry in ipairs(props) do
        if type(entry)~="table" or type(entry.name)~="string" then error("Propiedad mal formada") end
        local ok, value = pcall(convert, entry.value, entry.kind)
        if not ok then error("Conversión de "..entry.name..": "..tostring(value)) end
        local success, err=pcall(function() obj[entry.name]=value end)
        if not success then error("No se pudo establecer "..obj.ClassName.."."..entry.name..": "..tostring(err)) end
    end
end
local function createTree(node,parent,count)
    count=count or {n=0}; if type(node)~="table" then error("Nodo de instancia inválido") end
    count.n=count.n+1; if count.n>300 then error("Límite de 300 instancias por acción superado") end
    local className=node.className or node.class
    if type(className)~="string" or not allowedClasses[className] then error("Clase no permitida: "..tostring(className)) end
    local obj=Instance.new(className); obj.Name=safeName(node.name,"ABX_"..className)
    if className=="Part" then obj.Anchored=true end
    setProperties(obj,node.properties)
    obj.Parent=parent
    if node.children~=nil then
        if type(node.children)~="table" then error("children debe ser una lista") end
        for _,child in ipairs(node.children) do createTree(child,obj,count) end
    end
    return obj
end
local function findTarget(path)
    if type(path)~="string" then error("target debe ser una ruta") end
    return resolveParent(path,"Workspace")
end
local function createPart(data,parent)
    local shape=tostring(data.shape or "Block")
    local className=({Block="Part",Ball="Part",Cylinder="Part",Wedge="WedgePart",CornerWedge="CornerWedgePart",Truss="TrussPart",Mesh="MeshPart"})[shape]
    if not className then error("Forma física no compatible: "..shape) end
    local part=Instance.new(className); part.Name=safeName(data.name,"ABX_Part")
    if className=="Part" then
        if shape=="Ball" then part.Shape=Enum.PartType.Ball elseif shape=="Cylinder" then part.Shape=Enum.PartType.Cylinder end
    end
    local size=data.size or {4,1,4}; local pos=data.position or {0,5,0}; local rot=data.rotation or {0,0,0}
    part.Size=Vector3.new(math.clamp(tonumber(size[1]) or 4,.5,512),math.clamp(tonumber(size[2]) or 1,.5,512),math.clamp(tonumber(size[3]) or 4,.5,512))
    part.CFrame=CFrame.new(math.clamp(tonumber(pos[1]) or 0,-10000,10000),math.clamp(tonumber(pos[2]) or 5,-10000,10000),math.clamp(tonumber(pos[3]) or 0,-10000,10000))*CFrame.Angles(math.rad(tonumber(rot[1]) or 0),math.rad(tonumber(rot[2]) or 0),math.rad(tonumber(rot[3]) or 0))
    if data.color then
        if type(data.color)=="table" then part.Color=convert(data.color,"Color3")
        else local ok,bc=pcall(BrickColor.new,data.color); if ok then part.BrickColor=bc end end
    end
    if data.material then
        local mat=Enum.Material[tostring(data.material)]; if not mat then error("Material desconocido: "..tostring(data.material)) end; part.Material=mat
    end
    if data.transparency~=nil then part.Transparency=math.clamp(tonumber(data.transparency) or 0,0,1) end
    if data.reflectance~=nil then part.Reflectance=math.clamp(tonumber(data.reflectance) or 0,0,1) end
    part.Anchored=data.anchored~=false; part.CanCollide=data.canCollide~=false
    part.Parent=parent; return part
end
local function inspect(inst,depth,limit)
    depth=depth or 0; limit=limit or 3
    local out={name=inst.Name,className=inst.ClassName,path=inst:GetFullName()}
    if inst:IsA("BasePart") then out.position={inst.Position.X,inst.Position.Y,inst.Position.Z}; out.size={inst.Size.X,inst.Size.Y,inst.Size.Z}; out.anchored=inst.Anchored end
    if inst:IsA("GuiObject") then out.visible=inst.Visible; out.size={inst.Size.X.Scale,inst.Size.X.Offset,inst.Size.Y.Scale,inst.Size.Y.Offset}; out.position={inst.Position.X.Scale,inst.Position.X.Offset,inst.Position.Y.Scale,inst.Position.Y.Offset}; if inst:IsA("TextLabel") or inst:IsA("TextButton") or inst:IsA("TextBox") then out.text=inst.Text end end
    out.children={}
    if depth<limit then for _,child in ipairs(inst:GetChildren()) do if #out.children<80 then table.insert(out.children,inspect(child,depth+1,limit)) end end end
    return out
end

local function executeAction(action)
    if type(action)~="table" or type(action.type)~="string" then error("Acción inválida") end
    local kind=action.type

    if kind=="CREATE_PART" then
        local obj=createPart(action,resolveParent(action.parent,"Workspace"))
        Selection:Set({obj})
        return "Pieza "..obj.ClassName.." creada y seleccionada."

    elseif kind=="CREATE_STRUCTURE" then
        if type(action.parts)~="table" or #action.parts<1 or #action.parts>60 then
            error("La estructura debe tener entre 1 y 60 piezas")
        end
        local model=Instance.new("Model")
        model.Name=safeName(action.name,"ABX_Structure")
        model.Parent=resolveParent(action.parent,"Workspace")
        local ok,err=pcall(function()
            for _,data in ipairs(action.parts) do createPart(data,model) end
        end)
        if not ok then model:Destroy(); error(err) end
        Selection:Set({model})
        return "Estructura creada con "..#action.parts.." piezas físicas."

    elseif kind=="CREATE_GUI" then
        local parent=resolveParent(action.parent,"StarterGui")
        local screen=Instance.new("ScreenGui")
        screen.Name=safeName(action.name,"ABX_Interface")
        screen.ResetOnSpawn=false
        screen.DisplayOrder=10
        local panel=Instance.new("Frame")
        panel.Name="MainPanel"
        panel.AnchorPoint=Vector2.new(0.5,0.5)
        panel.Position=UDim2.fromScale(0.5,0.5)
        panel.Size=UDim2.fromOffset(420,250)
        panel.BackgroundColor3=Color3.fromRGB(23,31,51)
        panel.BorderSizePixel=0
        local round=Instance.new("UICorner"); round.CornerRadius=UDim.new(0,14); round.Parent=panel
        local outline=Instance.new("UIStroke"); outline.Color=Color3.fromRGB(55,130,255); outline.Thickness=1.5; outline.Parent=panel
        local title=Instance.new("TextLabel")
        title.Name="Title"; title.BackgroundTransparency=1
        title.Position=UDim2.fromOffset(18,12); title.Size=UDim2.new(1,-36,0,38)
        title.Font=Enum.Font.GothamBold; title.TextSize=22
        title.TextColor3=Color3.fromRGB(240,245,255)
        title.TextXAlignment=Enum.TextXAlignment.Left
        title.Text=safeName(action.title,"Mi interfaz"); title.Parent=panel
        local body=Instance.new("TextLabel")
        body.Name="Description"; body.BackgroundTransparency=1
        body.Position=UDim2.fromOffset(18,58); body.Size=UDim2.new(1,-36,0,70)
        body.Font=Enum.Font.Gotham; body.TextSize=14
        body.TextColor3=Color3.fromRGB(155,170,195)
        body.TextWrapped=true; body.TextXAlignment=Enum.TextXAlignment.Left
        body.TextYAlignment=Enum.TextYAlignment.Top
        body.Text="Interfaz creada por ABX Build. Solicita elementos y comportamiento adicionales para personalizarla."
        body.Parent=panel
        panel.Parent=screen; screen.Parent=parent
        Selection:Set({screen})
        return "Interfaz base creada en "..parent:GetFullName()..". Es visual; aún no incluye lógica de botones."

    elseif kind=="CREATE_FOLDER" then
        local obj=Instance.new("Folder")
        obj.Name=safeName(action.name,"ABX_Folder")
        obj.Parent=resolveParent(action.parent,"ReplicatedStorage")
        Selection:Set({obj})
        return "Folder creado."

    elseif kind=="CREATE_VALUE" then
        local types={StringValue=true,BoolValue=true,IntValue=true,NumberValue=true}
        if not types[action.valueType] then error("Tipo de valor no permitido") end
        local obj=Instance.new(action.valueType)
        obj.Name=safeName(action.name,"ABX_Value")
        if action.valueType=="StringValue" then
            obj.Value=tostring(action.value or ""):sub(1,500)
        elseif action.valueType=="BoolValue" then
            obj.Value=action.value==true
        elseif action.valueType=="IntValue" then
            obj.Value=math.clamp(math.floor(tonumber(action.value) or 0),-1000000000,1000000000)
        else
            obj.Value=math.clamp(tonumber(action.value) or 0,-1000000000,1000000000)
        end
        obj.Parent=resolveParent(action.parent,"ReplicatedStorage")
        Selection:Set({obj})
        return action.valueType.." creado."

    elseif kind=="CREATE_REMOTE" then
        local types={RemoteEvent=true,RemoteFunction=true,BindableEvent=true,BindableFunction=true}
        if not types[action.remoteType] then error("Tipo remoto no permitido") end
        local obj=Instance.new(action.remoteType)
        obj.Name=safeName(action.name,"ABX_Remote")
        obj.Parent=resolveParent(action.parent,"ReplicatedStorage")
        Selection:Set({obj})
        return action.remoteType.." creado. La lógica cliente-servidor debe programarse por separado."

    elseif kind=="CREATE_OBJECT" then
        local allowed={
            Folder=true,Model=true,Attachment=true,PointLight=true,SpotLight=true,SurfaceLight=true,
            Highlight=true,Smoke=true,Fire=true,Sparkles=true,ClickDetector=true,ProximityPrompt=true,
            SpawnLocation=true,Seat=true,VehicleSeat=true,WeldConstraint=true,Animation=true,
            Sound=true,ParticleEmitter=true,Beam=true,Trail=true
        }
        if not allowed[action.className] then error("Clase de objeto no permitida") end
        local obj=Instance.new(action.className)
        obj.Name=safeName(action.name,"ABX_"..action.className)
        obj.Parent=resolveParent(action.parent,"Workspace")
        Selection:Set({obj})
        return action.className.." creado con propiedades predeterminadas."

    elseif kind=="CREATE_SYSTEM" then
        local system=action.system
        if system~="COINS" and system~="CHECKPOINTS" and system~="REBIRTHS" then
            error("Plantilla de sistema no permitida")
        end
        local folder=Instance.new("Folder")
        folder.Name="ABX_"..system
        folder.Parent=game:GetService("ReplicatedStorage")
        if system=="COINS" then
            local value=Instance.new("IntValue"); value.Name="Coins"; value.Value=0; value.Parent=folder
        elseif system=="CHECKPOINTS" then
            local value=Instance.new("IntValue"); value.Name="Checkpoint"; value.Value=0; value.Parent=folder
        else
            local value=Instance.new("IntValue"); value.Name="Rebirths"; value.Value=0; value.Parent=folder
        end
        Selection:Set({folder})
        return "Plantilla "..system.." creada en ReplicatedStorage. Es una estructura inicial, no un sistema de juego completo."

    elseif kind=="CREATE_TREE" then
        local parent=resolveParent(action.parent,"Workspace")
        local created=createTree(action.root or action.node,parent)
        Selection:Set({created})
        return "Árbol de instancias creado: "..created:GetFullName()

    elseif kind=="SET_PROPERTIES" then
        local target=findTarget(action.target)
        setProperties(target,action.properties)
        Selection:Set({target})
        return "Propiedades actualizadas: "..target:GetFullName()

    elseif kind=="DELETE_INSTANCE" then
        local target=findTarget(action.target)
        if target==game or target==workspace then error("No se permite eliminar el juego o Workspace") end
        local path=target:GetFullName()
        target:Destroy()
        Selection:Set({})
        return "Instancia eliminada: "..path

    elseif kind=="INSPECT_SELECTION" then
        local result={}
        for _,obj in ipairs(Selection:Get()) do table.insert(result,inspect(obj,0,tonumber(action.depth) or 3)) end
        preview.Text=HttpService:JSONEncode(result)
        return "Inspección de selección completada; resultado mostrado en la vista previa."

    elseif kind=="INSPECT_PATH" then
        local result=inspect(findTarget(action.target),0,tonumber(action.depth) or 3)
        preview.Text=HttpService:JSONEncode(result)
        return "Inspección completada para "..tostring(action.target)

    elseif kind=="CREATE_SCRIPT" then
        local allowed={ServerScriptService=true,StarterPlayerScripts=true,StarterCharacterScripts=true,StarterGui=true,Workspace=true,ServerStorage=true,ReplicatedStorage=true,StarterPack=true}
        if not allowed[action.location] then error("Ubicación de script no permitida") end
        if type(action.source)~="string" or action.source:match("^%s*$") or #action.source>10000 then
            error("Código vacío o supera el límite de 10000 caracteres")
        end
        local low=string.lower(action.source)
        for _,word in ipairs({"loadstring","getfenv","setfenv","insertservice","httpservice"}) do
            if low:find(word,1,true) then error("Código bloqueado: "..word) end
        end
        if low:match("require%s*%(") then error("require() enviado desde la web está bloqueado") end
        local isLocal=action.location=="StarterPlayerScripts" or action.location=="StarterCharacterScripts" or action.location=="StarterGui"
        local obj=Instance.new(isLocal and "LocalScript" or "Script")
        obj.Name=safeName(action.name,"ABX_GeneratedScript")
        obj.Source=action.source
        obj.Parent=resolveParent(action.location,"ServerScriptService")
        Selection:Set({obj})
        return "Script insertado en "..action.location..". Revísalo y pruébalo antes de publicar."
    else
        error("Acción no compatible: "..kind)
    end
end

local function pollOnce()
    if not sessionCode then setStatus(false,"Genera un código y conéctalo desde la web."); return end
    local data=request("GET","/poll/"..sessionCode)
    setStatus(data.connected==true,data.connected and "Página conectada. Esperando instrucciones." or "Código generado; falta conectar la web.")
    if type(data.script)=="string" and data.script~="" then
        local ok,action=pcall(function() return HttpService:JSONDecode(data.script) end)
        if not ok or type(action)~="table" then setLog("El servidor envió una acción no válida.",C.red); return end
        pendingAction=action; preview.Text=HttpService:JSONEncode(action); applyButton.Visible=true
        setLog("Acción recibida. Revisa el JSON antes de aplicarla.",C.orange)
    end
end
local function generateCode()
    local code=tostring(math.random(10000,99999))
    local ok,result=pcall(function() return request("POST","/register",{code=code}) end)
    if not ok or not result or result.ok~=true then sessionCode=nil; codeLabel.Text="Código: error"; setStatus(false,"No se pudo registrar el código. Comprueba backend y HTTP."); return end
    sessionCode=code; pendingAction=nil; preview.Text=""; applyButton.Visible=false; codeLabel.Text="Código: "..code
    setStatus(false,"Código creado. Escríbelo en la página web de ABX Build."); pcall(pollOnce)
end
generateButton.MouseButton1Click:Connect(generateCode)
checkButton.MouseButton1Click:Connect(function() local ok,err=pcall(pollOnce); if not ok then setStatus(false,"Error de conexión: "..tostring(err)) end end)
applyButton.MouseButton1Click:Connect(function()
    if not pendingAction then setLog("No hay ninguna acción pendiente.",C.orange); return end
    local action=pendingAction
    local ok,result=pcall(function()
        ChangeHistoryService:SetWaypoint("Antes de ABX Build v"..VERSION)
        local message=executeAction(action)
        ChangeHistoryService:SetWaypoint("Después de ABX Build v"..VERSION)
        return message
    end)
    if ok then pendingAction=nil; applyButton.Visible=false; setLog(result,C.green)
    else setLog("No se pudo aplicar: "..tostring(result),C.red) end
end)
openButton.Click:Connect(function() widget.Enabled=not widget.Enabled end)
task.spawn(function()
    while true do task.wait(3)
        if sessionCode and not isPolling then isPolling=true; local ok,err=pcall(pollOnce); if not ok then setStatus(false,"Error de conexión; reintentando: "..tostring(err)) end; isPolling=false end
    end
end)
setStatus(false,"Genera un código para conectar la página web.")
setLog("ABX Build v"..VERSION.." listo.",C.green)