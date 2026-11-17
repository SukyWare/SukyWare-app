--[[
    SukyWare - Verificação de Key + HWID
    Cole este bloco NO TOPO do hub, antes de ofuscar.

    Uso pelo cliente (antes do loadstring):
        getgenv().Key = "SUKY-XXXX-XXXX"
        loadstring(game:HttpGet('SEU_LINK_AQUI'))()
]]

local API_URL = "http://SEU_IP_OU_DOMINIO:3000/api/verificar" -- troque (de preferência HTTPS via proxy)

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local RbxAnalytics = game:GetService("RbxAnalyticsService")
local LocalPlayer = Players.LocalPlayer

local function sair(msg)
    warn("[SukyWare] " .. tostring(msg))
    pcall(function()
        LocalPlayer:Kick("[SukyWare] " .. tostring(msg))
    end)
    error("[SukyWare] " .. tostring(msg), 0)
end

local function pegarHwid()
    local ok, hwid = pcall(function()
        if gethwid then
            return tostring(gethwid())
        end
        return tostring(RbxAnalytics:GetClientId())
    end)
    if ok and hwid and hwid ~= "" then
        return hwid
    end
    return nil
end

local function pegarExecutor()
    local ok, nome = pcall(function()
        if identifyexecutor then
            return tostring((identifyexecutor()))
        end
        return "Desconhecido"
    end)
    return ok and nome or "Desconhecido"
end

local function requisitar(url)
    -- tenta game:HttpGet e cai para request/http_request
    local ok, corpo = pcall(function()
        return game:HttpGet(url)
    end)
    if ok and corpo and corpo ~= "" then
        return corpo
    end

    local req = (syn and syn.request) or request or http_request or (http and http.request)
    if req then
        local ok2, resp = pcall(function()
            return req({ Url = url, Method = "GET" })
        end)
        if ok2 and resp and resp.Body then
            return resp.Body
        end
    end
    return nil
end

local key = (getgenv and getgenv().Key) or script_key or ""
if type(key) ~= "string" or key == "" then
    sair("Key não informada. Use getgenv().Key = \"SUA-KEY\" antes de executar.")
end

local hwid = pegarHwid()
if not hwid then
    sair("Não foi possível obter o HWID.")
end

local function enc(v)
    return HttpService:UrlEncode(tostring(v))
end

local url = string.format(
    "%s?key=%s&hwid=%s&user=%s&userid=%s&executor=%s",
    API_URL,
    enc(key),
    enc(hwid),
    enc(LocalPlayer.Name),
    enc(LocalPlayer.UserId),
    enc(pegarExecutor())
)

local corpo = requisitar(url)
if not corpo then
    sair("Falha ao conectar ao servidor de verificação.")
end

local ok, dados = pcall(function()
    return HttpService:JSONDecode(corpo)
end)

if not ok or type(dados) ~= "table" then
    sair("Resposta inválida do servidor.")
end

if dados.valid ~= true then
    sair(dados.message or "Key inválida.")
end

print("[SukyWare] Key válida! " .. tostring(dados.restante or ""))

-- =========================================================
-- A PARTIR DAQUI vai o código do seu hub
-- =========================================================
