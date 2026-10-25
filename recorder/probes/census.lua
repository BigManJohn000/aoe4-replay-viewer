-- Census probe: loaded by tools/record_replay.py --probe after recorder/recorder.lua, whose RR_Time,
-- RR_Num and RR_EntityId it reuses. Lists the SCAR global namespace once, subscribes to every GE_
-- global event, and reports which events fire during replay playback and the context fields they carry.
-- Same authoring constraints as the recorder (no tilde, named global functions, pcall everywhere).
--
-- Records ("|" fields, ";" items):
--   QG|type|name;name;...            global names grouped by Lua type, RQ_BATCH per record
--   QT|table|key:f;key:n;...         function (f) and number (n) members of each global table
--   QV|name:type=value;...           every GE_ global
--   QS|event|ok  or  QS|event|error  subscription result; QS|install|n ends the setup
--   QE|t|event|n|key=value;...       context of the first RQ_MAX firings of each event
--   QC|t|event=count;...             cumulative firings per event, every RQ_EVERY seconds of game time
--   QX|where|message                 probe error
-- Context values: number/boolean as is, 'string, e/s/p/b + id for entities, squads, players and
-- blueprints, @x:z for positions, {key/type,...} for other tables.

RQ_MAX = 15
RQ_BATCH = 50
RQ_EVERY = 10
RQ_COUNT = {}

function RQ_Clean(s)
  return (string.gsub(tostring(s), "[|;\r\n]", "/"))
end

function RQ_Emit(kind, prefix, items)
  for i = 1, #items, RQ_BATCH do
    print("R|" .. kind .. "|" .. prefix .. table.concat(items, ";", i, math.min(i + RQ_BATCH - 1, #items)))
  end
end

function RQ_Members(name)
  local members, n = {}, 0
  for k, v in pairs(_G[name]) do
    n = n + 1
    if n > 4000 then break end
    local tv = type(v)
    if tv == "function" or tv == "number" then
      members[#members + 1] = RQ_Clean(k) .. ":" .. string.sub(tv, 1, 1)
    end
  end
  table.sort(members)
  if #members > 0 then RQ_Emit("QT", name .. "|", members) end
end

function RQ_Globals()
  local byType, tables = {}, {}
  for k, v in pairs(_G) do
    if type(k) == "string" then
      local tv = type(v)
      if byType[tv] == nil then byType[tv] = {} end
      local l = byType[tv]
      l[#l + 1] = k
      if tv == "table" and not (k == "_G") then tables[#tables + 1] = k end
    end
  end
  for tv, names in pairs(byType) do
    table.sort(names)
    RQ_Emit("QG", tv .. "|", names)
  end
  table.sort(tables)
  for _, name in ipairs(tables) do
    local ok, err = pcall(RQ_Members, name)
    if not ok then print("R|QX|members " .. name .. "|" .. RQ_Clean(err)) end
  end
end

function RQ_Value(v)
  local tv = type(v)
  if tv == "number" or tv == "boolean" then return tostring(v) end
  if tv == "string" then return "'" .. RQ_Clean(v) end
  if tv == "userdata" or tv == "table" then
    local s = RR_EntityId(v)
    if not (s == "?") then return s end
    if tv == "table" then
      if type(v.x) == "number" and type(v.z) == "number" then return "@" .. RR_Num(v.x) .. ":" .. RR_Num(v.z) end
      local keys = {}
      for k, x in pairs(v) do
        if #keys < 12 then keys[#keys + 1] = RQ_Clean(k) .. "/" .. type(x) end
      end
      return "{" .. table.concat(keys, ",") .. "}"
    end
    return "u?"
  end
  return tv
end

function RQ_Dump(name, n, c)
  local parts = {}
  if type(c) == "table" then
    for k, v in pairs(c) do parts[#parts + 1] = RQ_Clean(k) .. "=" .. RQ_Value(v) end
    table.sort(parts)
  else
    parts[1] = "ctx=" .. type(c) .. ":" .. RQ_Value(c)
  end
  print("R|QE|" .. RR_Time() .. "|" .. name .. "|" .. n .. "|" .. table.concat(parts, ";"))
end

function RQ_Fire(name, c)
  local n = (RQ_COUNT[name] or 0) + 1
  RQ_COUNT[name] = n
  if n <= RQ_MAX then
    local ok, err = pcall(RQ_Dump, name, n, c)
    if not ok then print("R|QX|" .. name .. "|" .. RQ_Clean(err)) end
  end
end

-- One named global handler per event: the context table does not say which event fired.
function RQ_Subscribe(name)
  local fname = "RQ_On_" .. name
  _G[fname] = function(c) RQ_Fire(name, c) end
  local ok, err = pcall(Rule_AddGlobalEvent, _G[fname], _G[name])
  print("R|QS|" .. name .. "|" .. (ok and "ok" or RQ_Clean(err)))
end

function RQ_Report()
  local items = {}
  for k, v in pairs(RQ_COUNT) do items[#items + 1] = k .. "=" .. v end
  table.sort(items)
  RQ_Emit("QC", RR_Time() .. "|", items)
end

function RQ_Install()
  RQ_Globals()
  local evs, vals = {}, {}
  for k, v in pairs(_G) do
    if type(k) == "string" and string.sub(k, 1, 3) == "GE_" then
      vals[#vals + 1] = k .. ":" .. type(v) .. "=" .. RQ_Clean(v)
      if not (type(v) == "function" or type(v) == "table") then evs[#evs + 1] = k end
    end
  end
  table.sort(vals)
  table.sort(evs)
  RQ_Emit("QV", "", vals)
  for _, name in ipairs(evs) do RQ_Subscribe(name) end
  Rule_AddInterval(RQ_Report, RQ_EVERY)
  print("R|QS|install|" .. #evs)
end

local ok, err = pcall(RQ_Install)
if not ok then print("R|QX|install|" .. RQ_Clean(err)) end
