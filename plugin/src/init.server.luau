--!strict

local HttpService = game:GetService("HttpService")
local StudioService = game:GetService("StudioService")

local Api = require(script.Api)
local Widget = require(script.Widget)

local API_BASE_URL = "https://api.tracestack.gg"
local CREDENTIAL_SETTING_PREFIX = "TraceAutofixCredentialV1"
local INSTALL_ID_SETTING = "TraceAutofixInstallIdV1"

type PairingRequest = Api.PairingRequest
type PluginSession = Api.PluginSession
type StudioContext = Api.StudioContext

local api = Api.new(API_BASE_URL)
local activePairing: PairingRequest? = nil
local credentialSetting =
	string.format("%s_%s_%s", CREDENTIAL_SETTING_PREFIX, tostring(game.GameId), tostring(game.PlaceId))
local savedCredential = plugin:GetSetting(credentialSetting)
local credential: string? = if type(savedCredential) == "string" and #savedCredential >= 32
	then savedCredential
	else nil

local savedInstallId = plugin:GetSetting(INSTALL_ID_SETTING)
local installId: string
if type(savedInstallId) == "string" and #savedInstallId >= 8 then
	installId = savedInstallId
else
	installId = HttpService:GenerateGUID(false)
	plugin:SetSetting(INSTALL_ID_SETTING, installId)
end

local toolbar = plugin:CreateToolbar("Trace")
local toolbarButton = toolbar:CreateButton("TraceAutofix", "Open Trace Autofix", "", "Trace Autofix")
toolbarButton.ClickableWhenViewportHidden = true

local widget

local function studioContext(): (StudioContext?, string?)
	local userId = StudioService:GetUserId()
	local universeId = game.GameId
	local placeId = game.PlaceId
	if userId <= 0 then return nil, "Sign in to Roblox Studio before connecting Trace." end
	if universeId <= 0 or placeId <= 0 then return nil, "Publish this place to Roblox before connecting Trace." end
	return {
		installId = installId,
		robloxUserId = tostring(userId),
		studioUniverseId = tostring(universeId),
		studioPlaceId = tostring(placeId),
	},
		nil
end

local function showConnect(errorMessage: string?)
	local context = studioContext()
	widget:setState({
		kind = "connect",
		universeId = if context then context.studioUniverseId else "Not available",
		errorMessage = errorMessage,
	})
end

local function showConnected(session: PluginSession)
	widget:setState({
		kind = "connected",
		projectName = session.project.name,
		sourceUniverseId = session.project.robloxUniverseId,
		targetUniverseId = session.targetUniverseId,
		placeId = session.studioPlaceId,
	})
end

local function openPairingPage()
	local pairing = activePairing
	if not pairing then return end
	local opened, openError = pcall(function() plugin:OpenWikiPage(pairing.browserUrl) end)
	if not opened then
		widget:setState({
			kind = "code",
			browserUrl = pairing.browserUrl,
			errorMessage = "Studio could not open your browser. Copy the link below into a browser.",
		})
		warn("[Trace Autofix] Could not open browser:", openError)
	end
end

local function startPairing()
	local context, contextError = studioContext()
	if not context then
		showConnect(contextError)
		return
	end
	widget:setState({
		kind = "loading",
		loadingMessage = "Creating a secure Studio connection…",
	})
	task.spawn(function()
		local response = api:startPairing(context)
		if not response.ok or not response.data then
			showConnect(response.errorMessage or "Trace could not start the connection.")
			return
		end
		activePairing = response.data
		widget:setState({
			kind = "code",
			browserUrl = activePairing.browserUrl,
		})
		openPairingPage()
	end)
end

local function verifyPairing(code: string)
	local pairing = activePairing
	if not pairing then
		showConnect("This connection request is no longer available. Start again.")
		return
	end
	widget:setState({
		kind = "loading",
		loadingMessage = "Verifying the code with Trace…",
	})
	task.spawn(function()
		local response = api:verifyPairing(pairing.requestId, pairing.clientProof, code)
		if not response.ok or not response.data then
			widget:setState({
				kind = "code",
				actionLabel = "Try code again",
				browserUrl = activePairing and activePairing.browserUrl or nil,
				errorMessage = response.errorMessage or "Trace could not verify that code.",
			})
			return
		end
		credential = response.data.token
		plugin:SetSetting(credentialSetting, credential)
		activePairing = nil
		showConnected(response.data)
	end)
end

local function disconnect()
	local token = credential
	credential = nil
	activePairing = nil
	plugin:SetSetting(credentialSetting, "")
	showConnect(nil)
	if token then task.spawn(function() api:revoke(token) end) end
end

widget = Widget.new(plugin, {
	onConnect = startPairing,
	onDisconnect = disconnect,
	onOpenBrowser = openPairingPage,
	onStartOver = function()
		activePairing = nil
		showConnect(nil)
	end,
	onVerify = verifyPairing,
})

toolbarButton.Click:Connect(function() widget:setEnabled(not widget:isEnabled()) end)
widget:onEnabledChanged(function() toolbarButton:SetActive(widget:isEnabled()) end)

showConnect(nil)

if credential then
	widget:setState({
		kind = "loading",
		loadingMessage = "Restoring your Trace connection…",
	})
	task.spawn(function()
		local response = api:getSession(credential)
		if response.ok and response.data then
			if
				response.data.targetUniverseId == tostring(game.GameId)
				and response.data.studioPlaceId == tostring(game.PlaceId)
			then
				showConnected(response.data)
			else
				credential = nil
				plugin:SetSetting(credentialSetting, "")
				showConnect("This saved connection belongs to a different Studio place.")
			end
		else
			credential = nil
			plugin:SetSetting(credentialSetting, "")
			showConnect(response.errorMessage)
		end
	end)
end
