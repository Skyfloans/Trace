--!strict

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local HttpService = game:GetService("HttpService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local StudioService = game:GetService("StudioService")

local Api = require(script.Api)
local Widget = require(script.Widget)

local API_BASE_URL = "https://api.tracestack.gg"
local CREDENTIAL_SETTING_PREFIX = "TraceAutofixCredentialV1"
local INSTALL_ID_SETTING = "TraceAutofixInstallIdV1"
local TRACE_LOGO_IMAGE = "rbxassetid://94183872785973"

type PairingRequest = Api.PairingRequest
type PluginSession = Api.PluginSession
type ProposalDetail = Api.ProposalDetail
type ProposalFile = Api.ProposalFile
type ProposalList = Api.ProposalList
type StudioContext = Api.StudioContext

type PreparedChange = {
	currentSource: string,
	mergedSource: string,
	script: LuaSourceContainer,
}

local api = Api.new(API_BASE_URL)
local activePairing: PairingRequest? = nil
local activeProposal: ProposalDetail? = nil
local currentReviews: ProposalList? = nil
local currentSession: PluginSession? = nil
local refreshGeneration = 0
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
local toolbarButton = toolbar:CreateButton("TraceAutofix", "Open Trace Autofix", TRACE_LOGO_IMAGE, "Trace Autofix")
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
	refreshGeneration += 1
	currentSession = nil
	currentReviews = nil
	activeProposal = nil
	local context = studioContext()
	widget:setState({
		kind = "connect",
		universeId = if context then context.studioUniverseId else "Not available",
		errorMessage = errorMessage,
	})
end

local function runIsActive(reviews: ProposalList): boolean
	return reviews.run ~= nil and (reviews.run.status == "queued" or reviews.run.status == "processing")
end

local function showReviews(errorMessage: string?, notice: string?)
	widget:setState({
		kind = "reviews",
		projectName = if currentSession then currentSession.project.name else "Trace",
		reviews = currentReviews,
		errorMessage = errorMessage,
		notice = notice,
	})
end

local function refreshReviews(errorMessage: string?)
	local token = credential
	if not token or not currentSession then
		showConnect("Connect this Studio to Trace before loading fixes.")
		return
	end
	refreshGeneration += 1
	local generation = refreshGeneration
	showReviews(errorMessage, nil)
	task.spawn(function()
		local response = api:getProposals(token)
		if generation ~= refreshGeneration then return end
		if not response.ok or not response.data then
			showReviews(response.errorMessage or "Trace could not load fix requests.", nil)
			return
		end
		currentReviews = response.data
		showReviews(nil, nil)
		local refreshDelay = if runIsActive(response.data) then 4 else 30
		task.delay(refreshDelay, function()
			if generation == refreshGeneration and credential == token then refreshReviews(nil) end
		end)
	end)
end

local function showConnected(session: PluginSession)
	currentSession = session
	currentReviews = nil
	activeProposal = nil
	refreshReviews(nil)
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
	refreshGeneration += 1
	plugin:SetSetting(credentialSetting, "")
	showConnect(nil)
	if token then task.spawn(function() api:revoke(token) end) end
end

local function openProposal(proposalId: string)
	local token = credential
	if not token then
		showConnect("Connect this Studio to Trace before reviewing fixes.")
		return
	end
	refreshGeneration += 1
	activeProposal = nil
	widget:setState({
		kind = "detail",
	})
	task.spawn(function()
		local response = api:getProposal(token, proposalId)
		if not response.ok or not response.data then
			widget:setState({
				kind = "detail",
				errorMessage = response.errorMessage or "Trace could not load this fix.",
			})
			return
		end
		activeProposal = response.data
		widget:setState({
			kind = "detail",
			proposal = activeProposal,
		})
	end)
end

local function normalizeSource(source: string): string return string.gsub(source, "\r\n", "\n") end

local function splitLines(source: string): { string } return string.split(normalizeSource(source), "\n") end

local function blockMatches(lines: { string }, startIndex: number, block: { string }): boolean
	if startIndex < 1 or startIndex + #block - 1 > #lines then return false end
	for index, line in block do
		if lines[startIndex + index - 1] ~= line then return false end
	end
	return true
end

local function findBlock(lines: { string }, block: { string }, expected: number): number?
	if #block == 0 then return nil end
	if blockMatches(lines, expected, block) then return expected end
	local found: number? = nil
	for index = 1, #lines - #block + 1 do
		if blockMatches(lines, index, block) then
			if found then return nil end
			found = index
		end
	end
	return found
end

local function replaceBlock(
	lines: { string },
	startIndex: number,
	oldCount: number,
	replacement: { string }
): { string }
	local merged = {}
	for index = 1, startIndex - 1 do
		table.insert(merged, lines[index])
	end
	for _, line in replacement do
		table.insert(merged, line)
	end
	for index = startIndex + oldCount, #lines do
		table.insert(merged, lines[index])
	end
	return merged
end

local function mergeFile(file: ProposalFile, currentSource: string): (string?, string?)
	local current = normalizeSource(currentSource)
	local base = normalizeSource(file.baseSource)
	if current == base then return normalizeSource(file.proposedSource), nil end

	local lines = splitLines(current)
	local patchDelta = 0
	local liveShift = 0
	for _, hunk in file.patch.hunks do
		local expected = math.max(1, hunk.oldStart + patchDelta + liveShift)
		local startIndex = findBlock(lines, hunk.oldBlock, expected)
		if not startIndex then
			return nil, "Studio has newer edits in or near " .. file.path .. ". No scripts were changed."
		end
		liveShift = startIndex - (hunk.oldStart + patchDelta)
		lines = replaceBlock(lines, startIndex, #hunk.oldBlock, hunk.newBlock)
		patchDelta += #hunk.newBlock - #hunk.oldBlock
	end
	return table.concat(lines, "\n"), nil
end

local function resolveScript(path: string): (LuaSourceContainer?, string?)
	local current: Instance = game
	for _, segment in string.split(path, ".") do
		local child = current:FindFirstChild(segment)
		if not child then return nil, "Could not find " .. path .. " in this Studio place." end
		current = child
	end
	if not current:IsA("LuaSourceContainer") then return nil, path .. " is no longer a script." end
	return current, nil
end

local function prepareChanges(proposal: ProposalDetail): ({ PreparedChange }?, string?)
	local prepared = {}
	local seenScripts: { [Instance]: boolean } = {}
	for _, file in proposal.files do
		local sourceContainer, resolveError = resolveScript(file.path)
		if not sourceContainer then return nil, resolveError end
		if seenScripts[sourceContainer] then
			return nil, "The proposal resolves multiple files to the same Studio script."
		end
		seenScripts[sourceContainer] = true
		local readSucceeded, currentOrError = pcall(
			function() return ScriptEditorService:GetEditorSource(sourceContainer) end
		)
		if not readSucceeded then return nil, "Studio would not allow Trace to read " .. file.path .. "." end
		local currentSource = currentOrError :: string
		local mergedSource, mergeError = mergeFile(file, currentSource)
		if not mergedSource then return nil, mergeError end
		table.insert(prepared, {
			currentSource = currentSource,
			mergedSource = mergedSource,
			script = sourceContainer,
		})
	end
	if #prepared == 0 then return nil, "This proposal contains no script changes." end
	return prepared, nil
end

local function applyPreparedChanges(prepared: { PreparedChange }): (boolean, string?)
	local recording = ChangeHistoryService:TryBeginRecording("Trace Autofix")
	if not recording then
		return false, "Studio could not start an undo recording. Finish the current plugin action and try again."
	end
	local applied = {}
	for _, change in prepared do
		local succeeded, updateError = pcall(function()
			ScriptEditorService:UpdateSourceAsync(change.script, function(latestSource: string)
				if normalizeSource(latestSource) ~= normalizeSource(change.currentSource) then
					error("source_changed_during_apply")
				end
				return change.mergedSource
			end)
		end)
		if not succeeded then
			for _, previous in applied do
				pcall(function()
					ScriptEditorService:UpdateSourceAsync(previous.script, function(latestSource: string)
						if normalizeSource(latestSource) == normalizeSource(previous.mergedSource) then
							return previous.currentSource
						end
						return latestSource
					end)
				end)
			end
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Cancel)
			if string.find(tostring(updateError), "source_changed_during_apply", 1, true) then
				return false, "A script changed while Trace was applying the fix. No changes were kept."
			end
			return false, "Studio could not update one of the scripts. No changes were kept."
		end
		table.insert(applied, change)
	end
	ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
	return true, nil
end

local function markConflict(proposal: ProposalDetail, message: string)
	local token = credential
	proposal.status = "conflict"
	proposal.failureReason = message
	widget:setState({
		kind = "detail",
		proposal = proposal,
		errorMessage = message,
	})
	if token then task.spawn(function() api:reviewProposal(token, proposal.id, "conflict", message) end) end
end

local function acceptProposal(proposalId: string)
	local token = credential
	local proposal = activeProposal
	if not token or not proposal or proposal.id ~= proposalId then return end
	widget:setState({
		kind = "detail",
		proposal = proposal,
		notice = "Checking the current Studio scripts before applying…",
	})
	task.spawn(function()
		local prepared, prepareError = prepareChanges(proposal)
		if not prepared then
			markConflict(proposal, prepareError or "The proposed patch conflicts with this Studio place.")
			return
		end
		local applied, applyError = applyPreparedChanges(prepared)
		if not applied then
			markConflict(proposal, applyError or "Studio could not apply this proposal safely.")
			return
		end
		local response = api:reviewProposal(token, proposal.id, "accepted", nil)
		proposal.status = "accepted"
		if not response.ok then
			widget:setState({
				kind = "detail",
				proposal = proposal,
				notice = "Changes applied. Trace could not sync the review status; your Studio undo action is still available.",
			})
			return
		end
		activeProposal = nil
		currentReviews = nil
		refreshReviews(nil)
	end)
end

local function rejectProposal(proposalId: string)
	local token = credential
	if not token then return end
	widget:setState({
		kind = "loading",
		loadingMessage = "Rejecting this proposal…",
	})
	task.spawn(function()
		local response = api:reviewProposal(token, proposalId, "rejected", nil)
		if not response.ok then
			widget:setState({
				kind = "detail",
				proposal = activeProposal,
				errorMessage = response.errorMessage or "Trace could not reject this proposal.",
			})
			return
		end
		activeProposal = nil
		currentReviews = nil
		refreshReviews(nil)
	end)
end

widget = Widget.new(plugin, {
	onAccept = acceptProposal,
	onBack = function()
		activeProposal = nil
		showReviews(nil, nil)
	end,
	onConnect = startPairing,
	onDisconnect = disconnect,
	onOpenProposal = openProposal,
	onRefresh = function() refreshReviews(nil) end,
	onReject = rejectProposal,
	onStartOver = function()
		activePairing = nil
		showConnect(nil)
	end,
	onVerify = verifyPairing,
}, TRACE_LOGO_IMAGE)

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
