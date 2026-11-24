--[[
  Arkada plugin for Millennium: IsThereAnyDeal, the backend part (the page part is plugin/src/prices.js).
  Written for Arkada; no code taken from anyone. IsThereAnyDeal API v2: https://docs.isthereanydeal.com/

  ItadPrices({ appid, country }) → the best price of a Steam game in the shops IsThereAnyDeal follows, right
  now, and its lowest price ever:
    { success = true, hasKey = true, data = { game, current = { shop, price, regular, cut, url },
      lowest = { shop, price, regular, cut, timestamp } } | nil, fromCache }      price = { amount, currency }
    { success = false, hasKey, error = "no key" | "bad key" | "rate" | "network" | "bad request" }
  ItadKey({ key }) → { success, hasKey }: keeps the user's own API key (an empty key removes it).
  ItadState() → { success = true, hasKey }.

  The key is the user's, from https://isthereanydeal.com/apps/my/ (an app registered there, free). It lives
  only in <Steam>/millennium/arkada-itad.json — next to Steam, never in the plugin's folder or the repository
  — and goes only to api.isthereanydeal.com (as the ITAD-API-Key header). Without a key nothing is asked.

  Requests: the game's ITAD id by its Steam id (POST /lookup/id/shop/61/v1, ["app/<id>"]; kept 30 days),
  then POST /games/overview/v2?country=<cc> [id] (kept CACHE_S, per game and country, in memory and in
  <Steam>/millennium/arkada-itad-cache.json). At most MAX_REQUESTS requests in WINDOW_S (ITAD allows 1000 in
  5 minutes); past that the answer is "rate" and nothing is asked.
]]

local http = require("http")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")

local M = {}

local API = "https://api.isthereanydeal.com/"
local TIMEOUT = 15
local CACHE_S = 6 * 60 * 60
local ID_S = 30 * 24 * 60 * 60
local MISS_S = 24 * 60 * 60
local WINDOW_S = 5 * 60
local MAX_REQUESTS = 60
local MAX_ENTRIES = 1000

local function log(s) logger:info("itad: " .. s) end

local function path(name) return millennium.get_install_path() .. "/" .. name end
local function read_json(file)
  local f = io.open(file, "r")
  if not f then return nil end
  local text = f:read("*a"); f:close()
  local ok, v = pcall(json.decode, text)
  return ok and type(v) == "table" and v or nil
end
local function write_json(file, v)
  local f = io.open(file, "w")
  if not f then return false end
  f:write(json.encode(v)); f:close()
  return true
end

-- ───────── The key ─────────
local key, key_loaded = nil, false
local function get_key()
  if not key_loaded then
    key_loaded = true
    local v = read_json(path("arkada-itad.json"))
    if v and type(v.key) == "string" and v.key ~= "" then key = v.key end
  end
  return key
end

-- ───────── The cache: [appid] = { id, at } and [appid .. ":" .. country] = { data, at } ─────────
local cache, cache_loaded = { ids = {}, prices = {} }, false
local function load_cache()
  if cache_loaded then return end
  cache_loaded = true
  local v = read_json(path("arkada-itad-cache.json"))
  if v and type(v.ids) == "table" and type(v.prices) == "table" then cache = v end
end
local function save_cache()
  local n, oldest, oldest_key = 0, nil, nil
  for k, e in pairs(cache.prices) do
    n = n + 1
    if not oldest or (e.at or 0) < oldest then oldest, oldest_key = e.at or 0, k end
  end
  if n > MAX_ENTRIES and oldest_key then cache.prices[oldest_key] = nil end
  write_json(path("arkada-itad-cache.json"), cache)
end

-- ───────── Requests, within the budget ─────────
local sent = {}
local function budget()
  local now, kept = os.time(), {}
  for _, t in ipairs(sent) do if now - t < WINDOW_S then kept[#kept + 1] = t end end
  sent = kept
  if #sent >= MAX_REQUESTS then return false end
  sent[#sent + 1] = now
  return true
end

-- POST API .. url with a JSON body → the decoded reply, or nil and the error ("bad key", "rate", "network")
local function post(url, body)
  if not budget() then return nil, "rate" end
  local response, err = http.request(API .. url, {
    method = "POST",
    headers = { ["Content-Type"] = "application/json", ["ITAD-API-Key"] = get_key(), ["User-Agent"] = "Arkada (Millennium plugin)" },
    data = json.encode(body),
    timeout = TIMEOUT,
  })
  if not response then log("request failed: " .. tostring(err)); return nil, "network" end
  if response.status == 401 or response.status == 403 then return nil, "bad key" end
  if response.status == 429 then return nil, "rate" end
  if response.status ~= 200 then log(url .. ": HTTP " .. tostring(response.status)); return nil, "network" end
  local ok, data = pcall(json.decode, response.body)
  if not ok or type(data) ~= "table" then return nil, "network" end
  return data
end

local function price_of(p)
  if type(p) ~= "table" or type(p.amount) ~= "number" then return nil end
  return { amount = p.amount, currency = type(p.currency) == "string" and p.currency or "USD" }
end
local function shop_of(s) return type(s) == "table" and type(s.name) == "string" and s.name or nil end
local function str(v) return type(v) == "string" and v or nil end

local function game_id(appid)
  local kept = cache.ids[appid]
  if kept and os.time() - (kept.at or 0) < (kept.id and ID_S or MISS_S) then return kept.id or false end
  local data, err = post("lookup/id/shop/61/v1", { "app/" .. appid })
  if not data then return nil, err end
  local id = str(data["app/" .. appid])
  cache.ids[appid] = { id = id, at = os.time() }
  return id or false
end

local function overview(id, country)
  local data, err = post("games/overview/v2?country=" .. country, { id })
  if not data then return nil, err end
  local entry = type(data.prices) == "table" and data.prices[1] or nil
  if type(entry) ~= "table" then return false end
  local out = { game = type(entry.urls) == "table" and str(entry.urls.game) or nil }
  local c, l = entry.current, entry.lowest
  if type(c) == "table" and price_of(c.price) then
    out.current = { shop = shop_of(c.shop), price = price_of(c.price), regular = price_of(c.regular), cut = tonumber(c.cut) or 0, url = str(c.url) }
  end
  if type(l) == "table" and price_of(l.price) then
    out.lowest = { shop = shop_of(l.shop), price = price_of(l.price), regular = price_of(l.regular), cut = tonumber(l.cut) or 0, timestamp = str(l.timestamp) }
  end
  if not out.current and not out.lowest then return false end
  return out
end

-- Arguments come as one table or as positional values in an order of Millennium's own: each is recognised by what it is
local function read_args(...)
  local appid, country, k
  local function take(v)
    if type(v) == "number" then appid = tostring(math.floor(v))
    elseif type(v) == "string" and v:match("^%d+$") then appid = v
    elseif type(v) == "string" and v:match("^%u%u$") then country = v
    elseif type(v) == "table" then
      if v.appid ~= nil then take(v.appid) end
      if v.country ~= nil then take(v.country) end
      if v.key ~= nil then k = tostring(v.key) end
    end
  end
  for i = 1, select("#", ...) do take(select(i, ...)) end
  return appid, country, k
end

function M.prices(...)
  local appid, country = read_args(...)
  country = country or "US"
  if not appid or #appid > 10 then return { success = false, error = "bad request" } end
  if not get_key() then return { success = false, hasKey = false, error = "no key" } end
  load_cache()
  local slot = appid .. ":" .. country
  local kept = cache.prices[slot]
  if kept and os.time() - (kept.at or 0) < (kept.data and CACHE_S or MISS_S) then
    return { success = true, hasKey = true, data = kept.data or nil, fromCache = true }
  end
  local id, err = game_id(appid)
  if id == nil then
    if kept then return { success = true, hasKey = true, data = kept.data or nil, fromCache = true, stale = true } end
    return { success = false, hasKey = true, error = err }
  end
  local data = false
  if id then
    data, err = overview(id, country)
    if data == nil then
      save_cache()
      if kept then return { success = true, hasKey = true, data = kept.data or nil, fromCache = true, stale = true } end
      return { success = false, hasKey = true, error = err }
    end
  end
  cache.prices[slot] = { data = data or nil, at = os.time() }
  save_cache()
  return { success = true, hasKey = true, data = data or nil, fromCache = false }
end

function M.set_key(...)
  local _, _, k = read_args(...)
  for i = 1, select("#", ...) do local v = select(i, ...); if type(v) == "string" and not v:match("^%d+$") and not v:match("^%u%u$") then k = v end end
  k = k and k:gsub("^%s+", ""):gsub("%s+$", "") or ""
  if k ~= "" and not k:match("^[%w%-_]+$") then return { success = false, hasKey = get_key() ~= nil, error = "bad key" } end
  if k ~= "" and (#k < 16 or #k > 128) then return { success = false, hasKey = get_key() ~= nil, error = "bad key" } end
  key_loaded = true
  key = k ~= "" and k or nil
  if not write_json(path("arkada-itad.json"), key and { key = key } or {}) then return { success = false, hasKey = key ~= nil, error = "cannot write" } end
  -- A new key may see what the old one could not: the prices are asked again
  load_cache()
  cache.prices = {}
  save_cache()
  log(key and "key saved" or "key removed")
  return { success = true, hasKey = key ~= nil }
end

function M.state() return { success = true, hasKey = get_key() ~= nil } end

return M
