--[[
  Arkada plugin for Millennium: How Long To Beat, the backend part (the frontend is plugin/src/hltb.js).

  GetHltbData(app_id, fallback_name, force_refresh) gives the completion times of a Steam game from
  howlongtobeat.com — main story, main + extras, completionist, in hours — with the same reply as the
  HLTB for Steam plugin, so that Steam Enhanced's card on a game's page (compat/hltb-for-steam) draws them:
    { success = true, data = { game_id, game_name, searched_name, comp_main, comp_plus, comp_100 },
      fromCache, isStale }        or { success = false, error }
  Nothing happens until the frontend says the feature is on (HltbSetup): while it is off every call
  answers { success = false, error = "off" } without a request, and the card asks the next plugin.

  HLTB has no public API. How its site is read (all of it from HLTB for Steam, see below):
    1. the home page → its NextJS build manifest (or, failing that, its script chunks) → the API path
       that has a matching "/init" path: the search endpoint (it moves: search, finder, find, search/site…);
    2. GET <search>/init?t=<ms> → { token, hpKey, hpVal }, kept 5 minutes;
    3. POST <search> with x-auth-token / x-hp-key / x-hp-val (hpKey = hpVal also in the body) → games;
    4. GET _next/data/<buildId>/game/<id>.json → one game by its HLTB id.
  A Steam game finds its HLTB id: from HLTB's import of the user's Steam library (public profiles only),
  from the table arkada_hltb_ids.lua, else by searching its English name (Steam's store API, l=english:
  the client may show the game's name in Russian) — exact name, then the closest name (Levenshtein),
  the Steam id of the best three checked on their HLTB pages, and once more without "Edition"-like tails.

  One request per game: answers are kept on disk (<Steam>/millennium/arkada-hltb-cache.json, so that a
  reinstall of the plugin keeps them). A found game is fresh for 7 days, a game HLTB does not know for
  1 day; after that it is still shown while it is asked again. A refresh asked sooner than a day after the
  last request is answered from the cache.

  Based on HLTB for Steam by Joey Doll — https://github.com/jcdoll/hltb-millennium-plugin, backend/*.lua
  at commit 7decc0a06bb2 (v2.2.0), MIT License; the license text is LICENSE-hltb next to this file, see
  also THIRD_PARTY.md. Taken from it: endpoint discovery, the auth token and the search request, the game
  page request, the Steam import, the name matching and its string helpers, the shape of the cache.
  Changed: one module instead of eight, every name local; the cache files, their lifetimes and the
  refresh limit; the on/off switch; the name fallback of SteamHunters and the settings are left out.
]]

local NOTICE = "How Long To Beat code based on HLTB for Steam by Joey Doll (github.com/jcdoll/hltb-millennium-plugin), MIT License, changed"

local http = require("http")
local json = require("json")
local logger = require("logger")
local millennium = require("millennium")

local M = { NOTICE = NOTICE }

local BASE_URL = "https://howlongtobeat.com/"
local USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
local TIMEOUT = 30
local TOKEN_TTL = 300
local SEARCH_SIZE = 20

local FRESH_FOUND = 7 * 24 * 60 * 60   -- a found game is asked again after a week
local FRESH_MISS = 24 * 60 * 60        -- a game HLTB does not know, after a day
local MIN_REFRESH = 24 * 60 * 60       -- a refresh sooner than this is answered from the cache
local MAX_AGE = 90 * 24 * 60 * 60
local MAX_ENTRIES = 2000

local function log(s) logger:info("hltb: " .. s) end

-- ───────── Endpoint discovery (hltb_endpoint_discovery.lua) ─────────
local cached_homepage, cached_search_url, cached_build_id

local function page_headers() return { ["User-Agent"] = USER_AGENT, ["referer"] = BASE_URL } end

local function get_homepage()
  if cached_homepage then return cached_homepage end
  local response = http.get(BASE_URL, { headers = page_headers(), timeout = TIMEOUT })
  if not response or response.status ~= 200 then log("home page failed"); return nil end
  cached_homepage = response.body
  return cached_homepage
end

local function collect_api_paths(content, paths)
  paths = paths or {}
  for api_path in content:gmatch('["\'`](/api/[a-zA-Z0-9_/%-]+)') do paths[api_path] = true end
  return paths
end

-- The search endpoint is the API path with a matching /init route
local function find_search_path(paths)
  local candidates = {}
  for api_path in pairs(paths) do
    if api_path:sub(-5) ~= "/init" and paths[api_path .. "/init"] then table.insert(candidates, api_path) end
  end
  table.sort(candidates)
  return candidates[1]
end

local function fetch_script(src) return http.get(BASE_URL .. src:sub(2), { headers = page_headers(), timeout = TIMEOUT }) end

local function search_path_from_manifest(homepage)
  local src = homepage:match('["\'](/_next/static/[^"\']+/_buildManifest%.js)["\']')
  if not src then return nil end
  local r = fetch_script(src)
  if not r or r.status ~= 200 or not r.body then return nil end
  return find_search_path(collect_api_paths(r.body))
end

local function search_path_from_chunks(homepage)
  local urls, seen = {}, {}
  for src in homepage:gmatch('["\'](/_next/static/chunks/[^"\']+%.js)["\']') do
    if not seen[src] then seen[src] = true; table.insert(urls, src) end
  end
  table.sort(urls)
  local paths = {}
  for _, src in ipairs(urls) do
    local r = fetch_script(src)
    if r and r.status == 200 and r.body then collect_api_paths(r.body, paths) end
  end
  return find_search_path(paths)
end

local function get_search_url()
  if cached_search_url then return cached_search_url end
  local homepage = get_homepage()
  if not homepage then return nil end
  local p = search_path_from_manifest(homepage) or search_path_from_chunks(homepage)
  if not p then log("no search endpoint found"); return nil end
  cached_search_url = BASE_URL .. p:sub(2)
  log("search endpoint " .. cached_search_url)
  return cached_search_url
end

local function get_build_id()
  if cached_build_id then return cached_build_id end
  local homepage = get_homepage()
  if not homepage then return nil end
  cached_build_id = homepage:match('/_next/static/([^/]+)/_ssgManifest%.js') or homepage:match('/_next/static/([^/]+)/_buildManifest%.js')
  return cached_build_id
end

local function invalidate() cached_homepage, cached_search_url, cached_build_id = nil, nil, nil end

-- ───────── The API (hltb_api.lua) ─────────
local cached_auth, auth_expires_at = nil, 0

local function fetch_auth_once()
  local search_url = get_search_url()
  if not search_url then return nil, "endpoint discovery failed" end
  local response, err = http.get(search_url .. "/init?t=" .. math.floor(os.time() * 1000), { headers = page_headers(), timeout = TIMEOUT })
  if not response then return nil, "request failed: " .. tostring(err) end
  if response.status ~= 200 then return nil, "HTTP " .. response.status end
  local ok, data = pcall(json.decode, response.body)
  if not ok or type(data) ~= "table" or not data.token then return nil, "no token" end
  return { token = data.token, key = data.hpKey, value = data.hpVal }
end

local function get_auth()
  local now = os.time()
  if cached_auth and now < auth_expires_at then return cached_auth end
  local auth, err = fetch_auth_once()
  if not auth then
    invalidate()
    auth, err = fetch_auth_once()
    if not auth then return nil, err end
  end
  cached_auth, auth_expires_at = auth, now + TOKEN_TTL
  return auth
end

local function search_once(query)
  local auth, err = get_auth()
  if not auth then return nil, "auth: " .. tostring(err) end
  local search_url = get_search_url()
  if not search_url then return nil, "endpoint discovery failed" end
  local terms = {}
  for word in query:gmatch("%S+") do table.insert(terms, word) end
  local payload = {
    searchType = "games", searchTerms = terms, searchPage = 1, size = SEARCH_SIZE,
    searchOptions = {
      games = {
        userId = 0, platform = "", sortCategory = "popular", rangeCategory = "main",
        rangeTime = { min = 0, max = 0 },
        gameplay = { perspective = "", flow = "", genre = "", difficulty = "" },
        rangeYear = { max = "", min = "" }, modifier = "",
      },
      users = { sortCategory = "postcount" }, lists = { sortCategory = "follows" },
      filter = "", sort = 0, randomizer = 0,
    },
    useCache = true,
  }
  if auth.key and auth.value then payload[tostring(auth.key)] = auth.value end
  local headers = {
    ["Content-Type"] = "application/json", ["Origin"] = "https://howlongtobeat.com", ["Referer"] = BASE_URL,
    ["Authority"] = "howlongtobeat.com", ["User-Agent"] = USER_AGENT, ["x-auth-token"] = auth.token,
  }
  if auth.key then headers["x-hp-key"] = tostring(auth.key) end
  if auth.value then headers["x-hp-val"] = tostring(auth.value) end
  return http.request(search_url, { method = "POST", headers = headers, data = json.encode(payload), timeout = TIMEOUT })
end

-- 403: the token expired → a new one, once; anything else: the endpoint may have moved → discover again, once
local function search(query)
  local response, err = search_once(query)
  if response and response.status == 403 then
    cached_auth = nil
    response, err = search_once(query)
  elseif not response or response.status ~= 200 then
    invalidate(); cached_auth = nil
    response, err = search_once(query)
  end
  if not response or response.status ~= 200 then log("search failed: " .. (response and ("HTTP " .. response.status) or tostring(err))); return nil end
  local ok, data = pcall(json.decode, response.body)
  if not ok or type(data) ~= "table" or type(data.data) ~= "table" then return nil end
  for _, item in ipairs(data.data) do
    if type(item.game_id) ~= "number" or type(item.game_name) ~= "string" or type(item.comp_all_count) ~= "number" then return nil end
  end
  return data.data
end

-- One game's page data by its HLTB id; the build id changes with every deploy of their site → once more
local function fetch_game_once(game_id)
  local build_id = get_build_id()
  if not build_id then return nil, "no build id" end
  return http.get(BASE_URL .. "_next/data/" .. build_id .. "/game/" .. tostring(game_id) .. ".json", { headers = page_headers(), timeout = TIMEOUT })
end

local function fetch_game(game_id)
  local response, err = fetch_game_once(game_id)
  if not response or response.status ~= 200 then
    invalidate()
    response, err = fetch_game_once(game_id)
  end
  if not response or response.status ~= 200 then return nil, response and ("HTTP " .. response.status) or tostring(err) end
  local ok, data = pcall(json.decode, response.body)
  local list = ok and type(data) == "table" and type(data.pageProps) == "table" and type(data.pageProps.game) == "table"
    and type(data.pageProps.game.data) == "table" and data.pageProps.game.data.game
  if type(list) ~= "table" or #list == 0 then return nil, "no game data" end
  return list[1]
end

local function fetch_steam_import(steam_user_id)
  local response, err = http.request(BASE_URL .. "api/steam/getSteamImportData", {
    method = "POST",
    headers = { ["Content-Type"] = "application/json", ["User-Agent"] = USER_AGENT, ["Referer"] = BASE_URL },
    data = json.encode({ steamUserId = steam_user_id, steamOmitData = 0 }),
    timeout = TIMEOUT,
  })
  if not response then return nil, "request failed: " .. tostring(err) end
  if response.status ~= 200 then return nil, "HTTP " .. response.status end
  local ok, data = pcall(json.decode, response.body)
  if not ok or type(data) ~= "table" or data.error or type(data.games) ~= "table" then return nil, "no games (the profile may be private)" end
  return data.games
end

-- ───────── Names (hltb_utils.lua, hltb_match.lua) ─────────
local function levenshtein(s1, s2)
  local len1, len2 = #s1, #s2
  local m = {}
  for i = 0, len1 do m[i] = { [0] = i } end
  for j = 0, len2 do m[0][j] = j end
  for i = 1, len1 do
    for j = 1, len2 do
      local cost = (s1:sub(i, i) == s2:sub(j, j)) and 0 or 1
      m[i][j] = math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost)
    end
  end
  return m[len1][len2]
end

local function sanitize(name)
  name = name:gsub("™", ""):gsub("®", ""):gsub("©", ""):gsub("\xe2\x80\x98", "'"):gsub("\xe2\x80\x99", "'")
  name = name:gsub("%(TM%)", ""):gsub("%(R%)", ""):gsub("%s+", " ")
  return name:match("^%s*(.-)%s*$") or name
end

-- The tails HLTB often leaves out of a name ("… Definitive Edition", "… Remastered", "(2013)"), each with an
-- optional " - " or ": " before it; repeated until nothing changes ("Enhanced Edition Director's Cut")
local TAILS = {
  "%d+[snrt][tdh]%s+[Aa]nniversary%s+[Ee]dition", "[Aa]nniversary%s+[Ee]dition", "[Ee]nhanced%s+[Ee]dition",
  "[Cc]omplete%s+[Ee]dition", "[Dd]efinitive%s+[Ee]dition", "[Uu]ltimate%s+[Ee]dition", "[Ss]pecial%s+[Ee]dition",
  "[Ll]egacy%s+[Ee]dition", "[Mm]aximum%s+[Ee]dition", "GOTY%s+[Ee]dition", "GOTY",
  "[Gg]ame%s+of%s+the%s+[Yy]ear%s+[Ee]dition", "[Gg]ame%s+of%s+the%s+[Yy]ear", "[Dd]eluxe%s+[Ee]dition",
  "[Pp]remium%s+[Oo]nline%s+[Ee]dition", "[Pp]remium%s+[Ee]dition", "[Ss]team%s+[Ee]dition", "[Rr]emastered",
  "%([3Dd]+%s*[Rr]emake%)", "[Rr]emake", "[Dd]irector'?s?%s+[Cc]ut", "[Cc]ollection", "%([Ll]egacy%)",
  "[Cc]lassic", "%(CLASSIC%)", "HD", "[Ee]nhanced", "[Ss]ingle%s+[Pp]layer", "[Ss]eason%s+%d+", "[Oo]nline",
  "%([12][09]%d%d%)",
}
local function simplify(name)
  name = name:gsub("–", "-"):gsub("—", "-")
  local prev
  repeat
    prev = name
    for _, t in ipairs(TAILS) do
      name = name:gsub("%s+[-:]%s*" .. t .. "$", ""):gsub("%s+" .. t .. "$", "")
    end
    name = name:gsub("%s*[-:]%s*$", "")
  until name == prev
  name = name:gsub("%s+", " ")
  return name:match("^%s*(.-)%s*$") or name
end

local function hours(seconds)
  if type(seconds) ~= "number" or seconds <= 0 then return nil end
  return math.floor((seconds / 3600) * 10 + 0.5) / 10
end

local function find_best(query, app_id)
  local results = search(query)
  if not results or #results == 0 then return nil end
  local q = sanitize(query):lower()
  for _, item in ipairs(results) do
    if sanitize(item.game_name):lower() == q then return item, 0 end
  end
  local choices = {}
  for _, item in ipairs(results) do
    table.insert(choices, { distance = levenshtein(q, sanitize(item.game_name):lower()), count = item.comp_all_count, item = item })
  end
  table.sort(choices, function(a, b)
    if a.distance == b.distance then return a.count > b.count end
    return a.distance < b.distance
  end)
  for i = 1, math.min(3, #choices) do
    local g = fetch_game(choices[i].item.game_id)
    if g and g.profile_steam == app_id then return choices[i].item, 0 end
  end
  return choices[1].item, choices[1].distance
end

local function search_best(name, app_id)
  local best, distance = find_best(name, app_id)
  local simple = simplify(name)
  if simple ~= name and (not best or distance > math.max(5, math.floor(#name * 0.2))) then
    local again, d2 = find_best(simple, app_id)
    if again and (not best or d2 < distance) then best = again end
  end
  return best
end

-- [S] Steam's store API, in English: the names HLTB knows
local function english_name(app_id)
  local response = http.get("https://store.steampowered.com/api/appdetails?appids=" .. app_id .. "&l=english", { timeout = 10 })
  if not response or response.status ~= 200 then return nil end
  local ok, data = pcall(json.decode, response.body)
  local entry = ok and type(data) == "table" and data[tostring(app_id)]
  if type(entry) ~= "table" or not entry.success or type(entry.data) ~= "table" then return nil end
  return type(entry.data.name) == "string" and entry.data.name or nil
end

-- ───────── The cache (cache.lua) ─────────
local results = {}                       -- [app_id string] = { data, timestamp }
local ids = { mappings = {}, steamUserId = nil, timestamp = nil }
local loaded = false

local function cache_path(name) return millennium.get_install_path() .. "/" .. name end
local function read_json(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local text = f:read("*a"); f:close()
  local ok, v = pcall(json.decode, text)
  return ok and type(v) == "table" and v or nil
end
local function write_json(path, v)
  local f = io.open(path, "w")
  if not f then return false end
  f:write(json.encode(v)); f:close()
  return true
end

local function load()
  if loaded then return end
  loaded = true
  local r = read_json(cache_path("arkada-hltb-cache.json"))
  if r then for k, v in pairs(r) do if tonumber(k) and type(v) == "table" and tonumber(v.timestamp) then results[k] = v end end end
  local i = read_json(cache_path("arkada-hltb-ids.json"))
  if i and type(i.mappings) == "table" then ids = { mappings = i.mappings, steamUserId = i.steamUserId, timestamp = tonumber(i.timestamp) } end
end

local function save()
  local now, list = os.time(), {}
  for k, v in pairs(results) do
    if now - v.timestamp > MAX_AGE then results[k] = nil else table.insert(list, { k = k, t = v.timestamp }) end
  end
  if #list > MAX_ENTRIES then
    table.sort(list, function(a, b) return a.t > b.t end)
    for n = MAX_ENTRIES + 1, #list do results[list[n].k] = nil end
  end
  write_json(cache_path("arkada-hltb-cache.json"), results)
end

local function is_found(data) return type(data) == "table" and data.game_id ~= nil end

-- New times over old ones, field by field: HLTB sometimes answers without one of them
local function merge(new, old)
  if type(old) ~= "table" then return new end
  local m = {}
  for k, v in pairs(new) do m[k] = v end
  if not m.game_id and old.game_id then m.game_id, m.game_name = old.game_id, m.game_name or old.game_name end
  for _, f in ipairs({ "comp_main", "comp_plus", "comp_100" }) do
    if (m[f] or 0) <= 0 and (old[f] or 0) > 0 then m[f] = old[f] end
  end
  return m
end

-- ───────── What the frontend and the card call ─────────
local enabled = false
local GAME_IDS = nil

local function times_of(g, searched)
  return { searched_name = searched or g.game_name or "", game_id = g.game_id, game_name = g.game_name,
    comp_main = hours(g.comp_main), comp_plus = hours(g.comp_plus), comp_100 = hours(g.comp_100) }
end

local function fetch_fresh(app_id, fallback_name)
  local known = ids.mappings[tostring(app_id)]
  if not GAME_IDS then
    local ok, t = pcall(require, "arkada_hltb_ids")
    GAME_IDS = ok and type(t) == "table" and t or {}
  end
  for _, hltb_id in ipairs({ known or false, GAME_IDS[app_id] or false }) do
    if hltb_id then
      local g = fetch_game(hltb_id)
      if g then return times_of(g) end
    end
  end
  local name = english_name(app_id) or fallback_name
  if not name or name == "" then return nil, "no name for app " .. tostring(app_id) end
  local searched = sanitize(name)
  local best = search_best(searched, app_id)
  if not best then return { searched_name = searched } end
  return times_of(best, searched)
end

function M.get(app_id, fallback_name, force_refresh)
  if not enabled then return { success = false, error = "off" } end
  app_id = tonumber(app_id)
  if not app_id or app_id <= 0 or app_id ~= math.floor(app_id) then return { success = false, error = "bad app id" } end
  if type(fallback_name) ~= "string" then fallback_name = nil end
  load()
  local key, now = tostring(app_id), os.time()
  local entry = results[key]
  if entry then
    local age = now - entry.timestamp
    local stale = age > (is_found(entry.data) and FRESH_FOUND or FRESH_MISS)
    if not force_refresh or age < MIN_REFRESH then
      return { success = true, data = entry.data, fromCache = not force_refresh, isStale = stale and not force_refresh }
    end
  end
  local data, err = fetch_fresh(app_id, fallback_name)
  if not data then
    log("app " .. key .. ": " .. tostring(err))
    if entry then return { success = true, data = entry.data, fromCache = true, isStale = false } end
    return { success = false, error = err or "unknown" }
  end
  data = merge(data, entry and entry.data)
  results[key] = { data = data, timestamp = now }
  save()
  log("app " .. key .. ": " .. (is_found(data) and (tostring(data.game_name) .. " (" .. tostring(data.game_id) .. ")") or "not on HLTB"))
  return { success = true, data = data, fromCache = false, isStale = false }
end

-- on: the feature's switch; steam_user_id: the user's SteamID64, for HLTB's import of the library (once per
-- user and per week; a private profile is simply not imported)
function M.setup(on, steam_user_id)
  enabled = on == true
  if not enabled or type(steam_user_id) ~= "string" or not steam_user_id:match("^%d+$") then return { success = true, on = enabled } end
  load()
  local fresh = ids.steamUserId == steam_user_id and next(ids.mappings) ~= nil and ids.timestamp and os.time() - ids.timestamp < FRESH_FOUND
  if fresh then return { success = true, on = true, imported = "kept" } end
  local games, err = fetch_steam_import(steam_user_id)
  if not games then log("steam import: " .. tostring(err)); return { success = true, on = true, imported = false } end
  local store, n = {}, 0
  for _, g in ipairs(games) do
    if type(g) == "table" and g.steam_id and g.hltb_id and g.hltb_id ~= 0 then store[tostring(g.steam_id)] = g.hltb_id; n = n + 1 end
  end
  ids = { mappings = store, steamUserId = steam_user_id, timestamp = os.time() }
  write_json(cache_path("arkada-hltb-ids.json"), ids)
  log("steam import: " .. n .. " game(s)")
  return { success = true, on = true, imported = n }
end

return M
