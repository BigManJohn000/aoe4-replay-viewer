-- Fidelity probe: loaded by tools/record_replay.py --probe after recorder/recorder.lua, whose RR_Time,
-- RR_Num, RR_EntityId and RR_Flush it reuses. Streams the global events the census probe saw firing during
-- playback, and samples population caps, production queues and squad idleness, so each can be checked
-- against the recorder's own records and the AoE4World summary before it goes into the recorder.
-- Same authoring constraints as the recorder (no tilde, named global functions, pcall everywhere).
--
-- Records (ids as RR_EntityId: e/s/p/b prefix; "-" for nil; positions @x:z):
--   QD|t|attacker,victim,damage,health,shieldDamage,repairing    GE_DamageReceived, every hit
--   QF|t|attacker,projectile,target                               GE_ProjectileFired
--   QL|t|attacker,projectile,target                               GE_ProjectileLanded
--   QB|t|player,blueprint,squad                                   GE_BuildItemComplete
--   QU|t|s/c/x/r,executer,upgrade                                 GE_Upgrade Start/Complete/Cancelled/Removed
--   QK|t|s/w/c/x,entity,blueprint,player                          GE_Construction Start/WorkerStart/Complete/Cancelled
--   QR|t|player|resource=amount,...                               GE_PlayerAddResource, non-zero amounts only
--   QSP|t|key=value,...                                           GE_StrategicPointChanged
--   QAB|t|ability,executer,target                                 GE_AbilityExecuted, first RF_ABMAX per ability
--   QAC|t|ability=count;...                                       GE_AbilityExecuted totals, every 60 s
--   QP|t|player index|population,cap,maxCap,popcapResource        every 2 s
--   QQ|t|entity,size,type,blueprint;...                           production queue size and head item, on change (0.5 s)
--   QI|t|squad,0/1;...                                            Squad_IsIdle, on change (1 s); a new squad starts as 0
--   QSEL|t|selected=n;cg0=n;...                                   local selection and control groups, every 300 s
--   QX|where|message                                              probe error, first per call site

RF_ABMAX = 200
RF_ERR = {}
RF_AB = {}
RF_HASQ = {}
RF_QSTATE = {}
RF_QBASE = nil
RF_IDLE = {}

function RF_Clean(s)
  return (string.gsub(tostring(s), "[|;,\r\n]", "/"))
end

function RF_Err(where, err)
  if RF_ERR[where] == nil then
    RF_ERR[where] = true
    print("R|QX|" .. where .. "|" .. RF_Clean(err))
  end
end

function RF_N(v)
  if type(v) == "number" then return string.format("%.2f", v) end
  return "-"
end

function RF_Val(v)
  if v == nil then return "-" end
  local tv = type(v)
  if tv == "number" then return RF_N(v) end
  if tv == "boolean" then return v and "1" or "0" end
  if tv == "string" then return RF_Clean(v) end
  local s = RR_EntityId(v)
  if s == "?" and tv == "table" and type(v.x) == "number" and type(v.z) == "number" then
    return "@" .. RR_Num(v.x) .. ":" .. RR_Num(v.z)
  end
  return s
end

function RF_Guard(where, fn, c)
  local ok, err = pcall(fn, c)
  if not ok then RF_Err(where, err) end
end

function RF_Damage(c)
  print("R|QD|" .. RR_Time() .. "|" .. RF_Val(c.attacker) .. "," .. RF_Val(c.victim) .. "," .. RF_N(c.damage) .. ","
    .. RF_N(c.currentHealth) .. "," .. RF_N(c.shieldDamage) .. "," .. (c.isRepairing and "1" or "0"))
end
function RF_OnDamage(c) RF_Guard("damage", RF_Damage, c) end

function RF_Projectile(kind, c)
  print("R|" .. kind .. "|" .. RR_Time() .. "|" .. RF_Val(c.attacker) .. "," .. RF_Val(c.projectile) .. "," .. RF_Val(c.target))
end
function RF_Fired(c) RF_Projectile("QF", c) end
function RF_Landed(c) RF_Projectile("QL", c) end
function RF_OnFired(c) RF_Guard("fired", RF_Fired, c) end
function RF_OnLanded(c) RF_Guard("landed", RF_Landed, c) end

function RF_Built(c)
  print("R|QB|" .. RR_Time() .. "|" .. RF_Val(c.player) .. "," .. RF_Val(c.pbg) .. "," .. RF_Val(c.spawnedSquad))
end
function RF_OnBuilt(c) RF_Guard("built", RF_Built, c) end

function RF_Upgrade(kind, c)
  print("R|QU|" .. RR_Time() .. "|" .. kind .. "," .. RF_Val(c.executer) .. "," .. RF_Val(c.upgrade))
end
function RF_UpStart(c) RF_Upgrade("s", c) end
function RF_UpDone(c) RF_Upgrade("c", c) end
function RF_UpCancel(c) RF_Upgrade("x", c) end
function RF_UpRemove(c) RF_Upgrade("r", c) end
function RF_OnUpStart(c) RF_Guard("upgrade", RF_UpStart, c) end
function RF_OnUpDone(c) RF_Guard("upgrade", RF_UpDone, c) end
function RF_OnUpCancel(c) RF_Guard("upgrade", RF_UpCancel, c) end
function RF_OnUpRemove(c) RF_Guard("upgrade", RF_UpRemove, c) end

function RF_Construction(kind, c)
  print("R|QK|" .. RR_Time() .. "|" .. kind .. "," .. RF_Val(c.entity) .. "," .. RF_Val(c.pbg) .. "," .. RF_Val(c.player))
end
function RF_ConStart(c) RF_Construction("s", c) end
function RF_ConWorker(c) RF_Construction("w", c) end
function RF_ConDone(c) RF_Construction("c", c) end
function RF_ConCancel(c) RF_Construction("x", c) end
function RF_OnConStart(c) RF_Guard("construction", RF_ConStart, c) end
function RF_OnConWorker(c) RF_Guard("construction", RF_ConWorker, c) end
function RF_OnConDone(c) RF_Guard("construction", RF_ConDone, c) end
function RF_OnConCancel(c) RF_Guard("construction", RF_ConCancel, c) end

function RF_Resource(c)
  local parts = {}
  if type(c.resources) == "table" then
    for k, v in pairs(c.resources) do
      if type(v) == "number" and not (v == 0) then parts[#parts + 1] = RF_Clean(k) .. "=" .. RF_N(v) end
    end
  end
  table.sort(parts)
  print("R|QR|" .. RR_Time() .. "|" .. RF_Val(c.player) .. "|" .. table.concat(parts, ","))
end
function RF_OnResource(c) RF_Guard("resource", RF_Resource, c) end

function RF_Point(c)
  local parts = {}
  for k, v in pairs(c) do parts[#parts + 1] = RF_Clean(k) .. "=" .. RF_Val(v) end
  table.sort(parts)
  print("R|QSP|" .. RR_Time() .. "|" .. table.concat(parts, ","))
end
function RF_OnPoint(c) RF_Guard("point", RF_Point, c) end

function RF_Ability(c)
  local a = RF_Val(c.ability)
  local n = (RF_AB[a] or 0) + 1
  RF_AB[a] = n
  if n <= RF_ABMAX then
    print("R|QAB|" .. RR_Time() .. "|" .. a .. "," .. RF_Val(c.executer) .. "," .. RF_Val(c.target))
  end
end
function RF_OnAbility(c) RF_Guard("ability", RF_Ability, c) end

function RF_AbilityTotals()
  local items = {}
  for k, v in pairs(RF_AB) do items[#items + 1] = k .. "=" .. v end
  table.sort(items)
  RR_Flush("QAC", RR_Time(), items)
end

-- Population: the 2-argument form (player, capacity type) first, the 1-argument form as fallback.
function RF_Call(where, fn, p, extra)
  local ok, v = pcall(fn, p, extra)
  if ok then return RF_N(v) end
  local ok1, v1 = pcall(fn, p)
  if ok1 then return RF_N(v1) end
  RF_Err(where, v)
  return "-"
end

function RF_Pop()
  local t = RR_Time()
  for i = 1, World_GetPlayerCount() do
    local p = World_GetPlayerAt(i)
    print("R|QP|" .. t .. "|" .. i .. "|" .. RF_Call("population", Player_GetCurrentPopulation, p, CT_Personnel) .. ","
      .. RF_Call("popcap", Player_GetCurrentPopulationCap, p, CT_Personnel) .. ","
      .. RF_Call("maxpopcap", Player_GetMaxPopulationCap, p, CT_Personnel) .. ","
      .. RF_Call("popcapresource", Player_GetResource, p, RT_Popcap))
  end
end

function RF_ItemType(ty)
  if ty == PITEM_Spawn then return "spawn" end
  if ty == PITEM_Upgrade then return "upgrade" end
  if ty == PITEM_PlayerUpgrade then return "playerupgrade" end
  if ty == PITEM_SquadUpgrade then return "squadupgrade" end
  if ty == PITEM_SquadReinforce then return "reinforce" end
  return RF_Clean(ty)
end

-- Head of a non-empty queue. The index base (0 or 1) is learned on the first non-empty queue and reported once.
function RF_QueueHead(e)
  if RF_QBASE == nil then
    for base = 0, 1 do
      local okT = pcall(Entity_GetProductionQueueItemType, e, base)
      local okI = pcall(Entity_GetProductionQueueItem, e, base)
      if okT and okI then
        RF_QBASE = base
        print("R|QX|queue base|" .. base)
        break
      end
    end
    if RF_QBASE == nil then
      local _, err = pcall(Entity_GetProductionQueueItem, e, 0)
      RF_Err("queue item", err)
      return "?", "?"
    end
  end
  local okT, ty = pcall(Entity_GetProductionQueueItemType, e, RF_QBASE)
  local okI, it = pcall(Entity_GetProductionQueueItem, e, RF_QBASE)
  if not okT then RF_Err("queue item type", ty) end
  if not okI then RF_Err("queue item", it) end
  return (okT and RF_ItemType(ty) or "?"), (okI and RF_Val(it) or "?")
end

function RF_QueueEntity(out, seen, e)
  local id = Entity_GetID(e)
  local has = RF_HASQ[id]
  if has == nil then
    local ok, h = pcall(Entity_HasProductionQueue, e)
    if not ok then RF_Err("has queue", h) end
    has = (ok and h) and true or false
    RF_HASQ[id] = has
  end
  if not has then return end
  seen[id] = true
  local ok, size = pcall(Entity_GetProductionQueueSize, e)
  if not ok then
    RF_Err("queue size", size)
    return
  end
  local ty, bp = "-", "-"
  if size > 0 then ty, bp = RF_QueueHead(e) end
  local key = size .. "," .. ty .. "," .. bp
  if not (RF_QSTATE[id] == key) then
    RF_QSTATE[id] = key
    out[#out + 1] = id .. "," .. key
  end
end

function RF_Queues()
  local out, seen = {}, {}
  for i = 1, World_GetPlayerCount() do
    EGroup_ForEach(Player_GetAllEntities(World_GetPlayerAt(i)), function(gid, idx, e)
      local ok, err = pcall(RF_QueueEntity, out, seen, e)
      if not ok then RF_Err("queue", err) end
      return false
    end)
  end
  for id, _ in pairs(RF_QSTATE) do
    if not seen[id] then RF_QSTATE[id] = nil end
  end
  RR_Flush("QQ", RR_Time(), out)
end

function RF_IdleSquad(out, seen, sq)
  local sid = Squad_GetID(sq)
  seen[sid] = true
  local ok, idle = pcall(Squad_IsIdle, sq)
  if not ok then
    RF_Err("idle", idle)
    return
  end
  local v = idle and 1 or 0
  local was = RF_IDLE[sid]
  if not (was == v) then
    if not (was == nil and v == 0) then out[#out + 1] = sid .. "," .. v end
    RF_IDLE[sid] = v
  end
end

function RF_Idle()
  local out, seen = {}, {}
  for i = 1, World_GetPlayerCount() do
    SGroup_ForEach(Player_GetSquads(World_GetPlayerAt(i)), function(gid, idx, sq)
      local ok, err = pcall(RF_IdleSquad, out, seen, sq)
      if not ok then RF_Err("idle squad", err) end
      return false
    end)
  end
  for sid, _ in pairs(RF_IDLE) do
    if not seen[sid] then RF_IDLE[sid] = nil end
  end
  RR_Flush("QI", RR_Time(), out)
end

function RF_SelectedCount()
  local sg = SGroup_CreateIfNotFound("rf_sel")
  SGroup_Clear(sg)
  Misc_GetSelectedSquads(sg, false)
  return SGroup_Count(sg)
end

function RF_GroupCount(g)
  local sg = SGroup_CreateIfNotFound("rf_cg")
  local eg = EGroup_CreateIfNotFound("rf_cge")
  SGroup_Clear(sg)
  EGroup_Clear(eg)
  Misc_GetControlGroupContents(g, sg, eg)
  return SGroup_Count(sg) + EGroup_Count(eg)
end

function RF_Selection()
  local parts = {}
  local ok, n = pcall(RF_SelectedCount)
  parts[1] = "selected=" .. (ok and tostring(n) or ("err " .. RF_Clean(n)))
  for g = 0, 9 do
    local okG, m = pcall(RF_GroupCount, g)
    parts[#parts + 1] = "cg" .. g .. "=" .. (okG and tostring(m) or ("err " .. RF_Clean(m)))
  end
  print("R|QSEL|" .. RR_Time() .. "|" .. table.concat(parts, ";"))
end

function RF_Pcall(where, fn)
  local ok, err = pcall(fn)
  if not ok then RF_Err(where, err) end
end
function RF_TickPop() RF_Pcall("pop", RF_Pop) end
function RF_TickQueues() RF_Pcall("queues", RF_Queues) end
function RF_TickIdle() RF_Pcall("idle tick", RF_Idle) end
function RF_TickSelection() RF_Pcall("selection", RF_Selection) end
function RF_TickAbilities() RF_Pcall("ability totals", RF_AbilityTotals) end

function RF_Install()
  Rule_AddGlobalEvent(RF_OnDamage, GE_DamageReceived)
  Rule_AddGlobalEvent(RF_OnFired, GE_ProjectileFired)
  Rule_AddGlobalEvent(RF_OnLanded, GE_ProjectileLanded)
  Rule_AddGlobalEvent(RF_OnBuilt, GE_BuildItemComplete)
  Rule_AddGlobalEvent(RF_OnUpStart, GE_UpgradeStart)
  Rule_AddGlobalEvent(RF_OnUpDone, GE_UpgradeComplete)
  Rule_AddGlobalEvent(RF_OnUpCancel, GE_UpgradeCancelled)
  Rule_AddGlobalEvent(RF_OnUpRemove, GE_UpgradeRemoved)
  Rule_AddGlobalEvent(RF_OnConStart, GE_ConstructionStart)
  Rule_AddGlobalEvent(RF_OnConWorker, GE_ConstructionWorkerStart)
  Rule_AddGlobalEvent(RF_OnConDone, GE_ConstructionComplete)
  Rule_AddGlobalEvent(RF_OnConCancel, GE_ConstructionCancelled)
  Rule_AddGlobalEvent(RF_OnResource, GE_PlayerAddResource)
  Rule_AddGlobalEvent(RF_OnPoint, GE_StrategicPointChanged)
  Rule_AddGlobalEvent(RF_OnAbility, GE_AbilityExecuted)
  Rule_AddInterval(RF_TickPop, 2)
  Rule_AddInterval(RF_TickQueues, 0.5)
  Rule_AddInterval(RF_TickIdle, 1)
  Rule_AddInterval(RF_TickSelection, 300)
  Rule_AddInterval(RF_TickAbilities, 60)
  RF_TickPop()
  RF_TickSelection()
  print("R|QX|install|ok")
end

local ok, err = pcall(RF_Install)
if not ok then print("R|QX|install|" .. RF_Clean(err)) end
