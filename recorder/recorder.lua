-- AoE4 replay recorder. Runs inside the game's SCAR (Lua 5.3) state during replay
-- playback and prints compact "R|..." records, which the game mirrors to
-- LogFiles/<session>/scarlog.*.txt. tools/record_replay.py minifies this file and
-- types it into the -dev SCAR console.
--
-- Authoring constraints (enforced by the injector):
--   * no tilde characters: the console toggle key is Alt+Shift+tilde
--   * comments only as whole "--" lines or trailing "--" outside strings
--   * rules must be named global functions (anonymous rules are a fatal SCAR error)
--   * every rule body runs under pcall so a script error can never pause the sim
--
-- Record types (fields separated by "|", records inside a field by ";"):
--   HDR|ver|t|worldWidth|worldLength|playerCount
--   PL|idx|playerId|race|team|name
--   N|t|id,owner,blueprint,maxhp,isBuilding,squadId,x,z,hp      first sighting or full resync
--   S|t|id,x,z,hp                                               state change
--   O|t|id,owner                                                owner change
--   A|t|attackerId,targetId                                     current attack targets
--   V|t|id,mask                                                 bit (i-1) set: player i sees entity
--   X|t|id                                                      entity left the world
--   P|t|idx|food,wood,gold,stone|population                     player economy
--   J|t|idx|food,wood,gold,stone,other                          villagers by gather state (Squad_IsGatheringResourceType)
--   K|t|key=value;...                                           GE_EntityKilled context
--   U|t|key=value;...                                           GE_UpgradeComplete context
--   C|t|key=value;...                                           GE_ConstructionComplete context
--   B|owner|blueprint|squadSize|key=value,...|t                 resource quote at sample time (v4 omits t)
--   D|t|squadId,x,z  or  squadId,-                              squad move destination set / cleared
--   T|t                                                         sample heartbeat
--   GN|t|id,blueprint,x,z,amount                                neutral (gaia) entity first sighting
--   GS|t|id,x,z                                                 neutral animal/relic moved
--   GA|t|id,amount                                              neutral resource amount changed
--   GX|t|id                                                     neutral entity gone (depleted, claimed, picked up)
--   HMH|x0|z0|step|cols|rows                                    terrain height grid header (once)
--   HM|row|h,h,...                                              terrain heights along x at z = z0 + row * step
--   ERR|where|message
--   READY|t|nonce                                              controller session identity

RR_VERSION = 5
RR_INTERVAL = 0.5
RR_MAXREC = 60
RR_HSTEP = 4

function RR_Num(v)
  return string.format("%.1f", v)
end

function RR_Time()
  return string.format("%.3f", World_GetGameTime())
end

function RR_Flush(kind, t, recs)
  local n = #recs
  local i = 1
  while i <= n do
    local j = math.min(i + RR_MAXREC - 1, n)
    print("R|" .. kind .. "|" .. t .. "|" .. table.concat(recs, ";", i, j))
    i = j + 1
  end
end

function RR_Header()
  local n = World_GetPlayerCount()
  print("R|HDR|" .. RR_VERSION .. "|" .. RR_Time() .. "|" .. World_GetWidth() .. "|" .. World_GetLength() .. "|" .. n)
  for i = 1, n do
    local p = World_GetPlayerAt(i)
    local okId, pid = pcall(Player_GetID, p)
    local okRace, race = pcall(Player_GetRaceName, p)
    local okTeam, team = pcall(Player_GetTeam, p)
    local okName, name = pcall(function() return tostring(Player_GetDisplayName(p)) end)
    print("R|PL|" .. i .. "|" .. tostring(okId and pid or -1) .. "|" .. tostring(okRace and race or "?")
      .. "|" .. tostring(okTeam and team or -1) .. "|" .. tostring(okName and name or "?"))
  end
end

function RR_PlayerStats(t, i, p)
  local r = {}
  for k = 1, #RR_RT do
    local ok, v = pcall(Player_GetResource, p, RR_RT[k])
    r[k] = ok and tostring(math.floor(v)) or "-1"
  end
  local okPop, pop = pcall(Player_GetCurrentPopulation, p, CT_Personnel)
  print("R|P|" .. t .. "|" .. i .. "|" .. table.concat(r, ",") .. "|" .. (okPop and tostring(math.floor(pop)) or "-1"))
end

-- Villager jobs as the engine reports them; "other" = idle, building, walking without a gather order.
function RR_Jobs(t, i, p)
  local n = { 0, 0, 0, 0, 0 }
  SGroup_ForEach(Player_GetSquads(p), function(gid, idx, sq)
    if string.find(BP_GetName(Squad_GetBlueprint(sq)), "villager", 1, true) then
      local k = 5
      for j = 1, 4 do
        if Squad_IsGatheringResourceType(sq, RR_RT[j]) then
          k = j
          break
        end
      end
      n[k] = n[k] + 1
    end
    return false
  end)
  print("R|J|" .. t .. "|" .. i .. "|" .. table.concat(n, ","))
end

function RR_EntityId(v)
  local ok, r = pcall(Entity_GetID, v)
  if ok and r then return "e" .. r end
  ok, r = pcall(Squad_GetID, v)
  if ok and r then return "s" .. r end
  ok, r = pcall(Player_GetID, v)
  if ok and r then return "p" .. r end
  ok, r = pcall(BP_GetName, v)
  if ok and r then return "b" .. r end
  return "?"
end

function RR_EvDump(tag, c)
  local parts = {}
  if type(c) == "table" then
    for k, v in pairs(c) do
      local tv = type(v)
      local s
      if tv == "number" or tv == "boolean" or tv == "string" then
        s = tostring(v)
      elseif tv == "userdata" or tv == "table" then
        s = RR_EntityId(v)
        if s == "?" and tv == "table" and type(v.x) == "number" and type(v.z) == "number" then
          s = RR_Num(v.x) .. ":" .. RR_Num(v.z)
        end
      else
        s = tv
      end
      parts[#parts + 1] = tostring(k) .. "=" .. s
    end
  end
  print("R|" .. tag .. "|" .. RR_Time() .. "|" .. table.concat(parts, ";"))
end

function RR_OnKill(c)
  local ok, err = pcall(RR_EvDump, "K", c)
  if not ok then print("R|ERR|kill|" .. tostring(err)) end
end

function RR_UpgradeBody(c)
  RR_EvDump("U", c)
  local ok, id = pcall(Entity_GetID, c.executer)
  local rec = ok and RR_E[id]
  if rec then RR_BPC[rec[4]] = nil end
end

function RR_OnUpgrade(c)
  local ok, err = pcall(RR_UpgradeBody, c)
  if not ok then print("R|ERR|upgrade|" .. tostring(err)) end
end

function RR_OnConstruction(c)
  local ok, err = pcall(RR_EvDump, "C", c)
  if not ok then print("R|ERR|construction|" .. tostring(err)) end
end

function RR_Cost(p, i, bp, pbg, sq, t)
  local ok, c, n = false, nil, 0
  if sq then
    ok, c = pcall(function() return Player_GetSquadBPCost(p, Squad_GetBlueprint(sq)) end)
    if ok then
      local okN, cnt = pcall(Squad_Count, sq)
      n = (okN and cnt) or 1
    end
  end
  if not ok then
    ok, c = pcall(Player_GetEntityBPCost, p, pbg)
    n = 0
  end
  if not ok or not (type(c) == "table") then return end
  local parts = {}
  for k, v in pairs(c) do
    if type(v) == "number" and not (v == 0) then parts[#parts + 1] = tostring(k) .. "=" .. RR_Num(v) end
  end
  print("R|B|" .. i .. "|" .. bp .. "|" .. n .. "|" .. table.concat(parts, ",") .. "|" .. t)
  return true
end

function RR_Destinations(p, dests)
  local ok, err = pcall(function()
    SGroup_ForEach(Player_GetSquads(p), function(gid, idx, sq)
      local sid = Squad_GetID(sq)
      local d = false
      if Squad_HasDestination(sq) then
        local pos = Squad_GetDestination(sq)
        d = RR_Num(pos.x) .. "," .. RR_Num(pos.z)
      end
      local prev = RR_SQ[sid]
      if not (prev == d) and not (prev == nil and d == false) then
        dests[#dests + 1] = sid .. "," .. (d or "-")
      end
      RR_SQ[sid] = d
      return false
    end)
  end)
  if not ok then
    RR_DEST = false
    print("R|ERR|dest|" .. tostring(err))
  end
end

-- 0 = ignore (minimap icons, spawn markers, decals), 1 = static (trees, mines, berries, sacred sites), 2 = moves
-- (animals, relics). Every scan re-reads the amount left of everything tracked, so trees being chopped show up too.
function RR_GaiaKind(bp)
  if bp:find("dummy") or bp:find("spawn_marker") or bp:find("splat") then return 0 end
  if bp:find("huntable") or bp:find("herdable") or bp:find("relic") then return 2 end
  return 1
end

function RR_GaiaAmount(e)
  local ok, a = pcall(Entity_GetRemainingResourceDepositAmount, e)
  if ok and a then return math.floor(a + 0.5) end
  return -1
end

-- Full neutral scan: new entities, amount changes and removals. Runs every 10 s of game time.
function RR_GaiaScan(t)
  local eg = RR_GEG
  EGroup_Clear(eg)
  World_GetAllNeutralEntities(eg)
  local seen, news, amts, gone = {}, {}, {}, {}
  EGroup_ForEach(eg, function(gid, idx, e)
    local id = Entity_GetID(e)
    seen[id] = true
    local r = RR_G[id]
    if r == nil then
      local bp = BP_GetName(Entity_GetBlueprint(e))
      local k = RR_GaiaKind(bp)
      if k == 0 then
        RR_G[id] = false
        return false
      end
      local pos = Entity_GetPosition(e)
      local a = RR_GaiaAmount(e)
      RR_G[id] = { k, pos.x, pos.z, a }
      news[#news + 1] = id .. "," .. bp .. "," .. RR_Num(pos.x) .. "," .. RR_Num(pos.z) .. "," .. a
      if k == 2 then RR_GMV[id] = true end
    elseif r then
      local a = RR_GaiaAmount(e)
      if not (a == r[4]) then
        r[4] = a
        amts[#amts + 1] = id .. "," .. a
      end
    end
    return false
  end)
  for id, r in pairs(RR_G) do
    if r and not seen[id] then
      gone[#gone + 1] = id
      RR_G[id] = nil
    end
  end
  RR_Flush("GN", t, news)
  RR_Flush("GA", t, amts)
  RR_Flush("GX", t, gone)
end

-- Positions of neutral animals and relics. Runs every second of game time.
-- Animals are squad entities, which EGroup_Add rejects with a fatal (uncatchable) SCAR error, so movers are kept
-- as an id set and checked with Entity_IsValid before Entity_FromID.
function RR_GaiaMove(t)
  local moves = {}
  for id, _ in pairs(RR_GMV) do
    local r = RR_G[id]
    if not r or not Entity_IsValid(id) then
      RR_GMV[id] = nil
    else
      local e = Entity_FromID(id)
      if World_OwnsEntity(e) then
        local pos = Entity_GetPosition(e)
        if math.abs(pos.x - r[2]) > 0.5 or math.abs(pos.z - r[3]) > 0.5 then
          r[2] = pos.x
          r[3] = pos.z
          moves[#moves + 1] = id .. "," .. RR_Num(pos.x) .. "," .. RR_Num(pos.z)
        end
      end
    end
  end
  RR_Flush("GS", t, moves)
end

function RR_Gaia(t)
  if RR_N % 20 == 0 then RR_GaiaScan(t) end
  if RR_N % 2 == 0 then RR_GaiaMove(t) end
end

-- Terrain height grid, cell centres every RR_HSTEP world units.
function RR_Terrain()
  local W, L = World_GetWidth(), World_GetLength()
  local step = RR_HSTEP
  local cols, rows = math.floor(W / step), math.floor(L / step)
  local x0, z0 = -W / 2 + step / 2, -L / 2 + step / 2
  print("R|HMH|" .. RR_Num(x0) .. "|" .. RR_Num(z0) .. "|" .. step .. "|" .. cols .. "|" .. rows)
  for row = 0, rows - 1 do
    local z = z0 + row * step
    local v = {}
    for c = 0, cols - 1 do v[c + 1] = RR_Num(World_GetHeightAt(x0 + c * step, z)) end
    print("R|HM|" .. row .. "|" .. table.concat(v, ","))
  end
end

function RR_SampleBody()
  local t = RR_Time()
  local np = World_GetPlayerCount()
  local doStats = (RR_N % 4 == 0)
  local doVis = RR_VIS and (RR_N % 2 == 0)
  local seen = {}
  local news, states, owners, atks, vis, dests = {}, {}, {}, {}, {}, {}
  local players = {}
  for i = 1, np do players[i] = World_GetPlayerAt(i) end

  for i = 1, np do
    local p = players[i]
    local eg = Player_GetAllEntities(p)
    EGroup_ForEach(eg, function(gid, idx, e)
      local id = Entity_GetID(e)
      seen[id] = true
      local pos = Entity_GetPosition(e)
      local x, z = pos.x, pos.z
      local hp = math.floor(Entity_GetHealth(e) + 0.5)
      local rec = RR_E[id]
      if rec == nil then
        local pbg = Entity_GetBlueprint(e)
        local bp = BP_GetName(pbg)
        local sid = 0
        local okSq, sq = pcall(Entity_GetSquad, e)
        if okSq and sq then
          local okId, r = pcall(Squad_GetID, sq)
          if okId and r then sid = r else sq = nil end
        else
          sq = nil
        end
        if RR_BPC[i] == nil then RR_BPC[i] = {} end
        if RR_BPC[i][bp] == nil then
          RR_BPC[i][bp] = RR_Cost(p, i, bp, pbg, sq, t) or false
        end
        local b = 0
        if Entity_IsBuilding(e) then b = 1 end
        news[#news + 1] = id .. "," .. i .. "," .. bp .. "," .. math.floor(Entity_GetHealthMax(e) + 0.5) .. ","
          .. b .. "," .. sid .. "," .. RR_Num(x) .. "," .. RR_Num(z) .. "," .. hp
        rec = { x, z, hp, i, -1 }
        RR_E[id] = rec
      else
        if not (rec[4] == i) then
          owners[#owners + 1] = id .. "," .. i
          rec[4] = i
        end
        if math.abs(rec[1] - x) > 0.25 or math.abs(rec[2] - z) > 0.25 or not (rec[3] == hp) then
          states[#states + 1] = id .. "," .. RR_Num(x) .. "," .. RR_Num(z) .. "," .. hp
          rec[1] = x
          rec[2] = z
          rec[3] = hp
        end
      end
      if Entity_IsAttacking(e, RR_INTERVAL) then
        local okT, te = pcall(Entity_GetAttackTargetEntity, e)
        if okT and te then
          local okI, tid = pcall(Entity_GetID, te)
          if okI and tid then atks[#atks + 1] = id .. "," .. tid end
        end
      end
      if doVis then
        local mask = 0
        for j = 1, np do
          if j == i then
            mask = mask | (1 << (j - 1))
          else
            local okV, v = pcall(Player_CanSeeEntity, players[j], e)
            if not okV then
              RR_VIS = false
              print("R|ERR|vis|" .. tostring(v))
              break
            end
            if v then mask = mask | (1 << (j - 1)) end
          end
        end
        if not (rec[5] == mask) then
          vis[#vis + 1] = id .. "," .. mask
          rec[5] = mask
        end
      end
      return false
    end)
    if doStats then
      RR_PlayerStats(t, i, p)
      if RR_JOBS then
        local okJ, errJ = pcall(RR_Jobs, t, i, p)
        if not okJ then
          RR_JOBS = false
          print("R|ERR|jobs|" .. tostring(errJ))
        end
      end
    end
    if RR_DEST and (RR_N % 2 == 0) then RR_Destinations(p, dests) end
  end

  local gone = {}
  for id, _ in pairs(RR_E) do
    if not seen[id] then
      gone[#gone + 1] = id
      RR_E[id] = nil
    end
  end

  RR_Flush("N", t, news)
  RR_Flush("O", t, owners)
  RR_Flush("S", t, states)
  RR_Flush("A", t, atks)
  RR_Flush("V", t, vis)
  RR_Flush("X", t, gone)
  RR_Flush("D", t, dests)
  if RR_GAIA then
    local okG, errG = pcall(RR_Gaia, t)
    if not okG then
      RR_GAIA = false
      print("R|ERR|gaia|" .. tostring(errG))
    end
  end
  print("R|T|" .. t)
end

function RR_Sample()
  local ok, err = pcall(RR_SampleBody)
  if not ok then
    RR_E = {}
    RR_SQ = {}
    RR_BPC = {}
    print("R|ERR|sample|" .. tostring(err))
  end
  RR_N = RR_N + 1
end

function RR_Install()
  RR_E = {}
  RR_N = 0
  RR_VIS = true
  RR_DEST = true
  RR_SQ = {}
  RR_BPC = {}
  RR_RT = {}
  if RT_Food then RR_RT = { RT_Food, RT_Wood, RT_Gold, RT_Stone } end
  RR_G = {}
  RR_JOBS = (#RR_RT == 4)
  RR_GAIA = true
  RR_GEG = EGroup_CreateIfNotFound("rr_gaia")
  RR_GMV = {}
  RR_Header()
  local okH, errH = pcall(RR_Terrain)
  if not okH then print("R|ERR|terrain|" .. tostring(errH)) end
  Rule_AddInterval(RR_Sample, RR_INTERVAL)
  Rule_AddGlobalEvent(RR_OnKill, GE_EntityKilled)
  Rule_AddGlobalEvent(RR_OnUpgrade, GE_UpgradeComplete)
  Rule_AddGlobalEvent(RR_OnConstruction, GE_ConstructionComplete)
  RR_Sample()
  print("R|READY|" .. RR_Time() .. "|" .. tostring(RR_NONCE))
end

if RR_ON then
  print("R|ALREADY|" .. RR_Time())
else
  RR_ON = true
  local ok, err = pcall(RR_Install)
  if not ok then print("R|ERR|install|" .. tostring(err)) end
end
