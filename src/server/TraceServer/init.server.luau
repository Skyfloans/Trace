local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ScriptContext = game:GetService("ScriptContext")

local Batcher = require(script.Batcher)
local Config = require(script.Config)
local LogCollector = require(script.LogStack)
local TraceShared = ReplicatedStorage:WaitForChild("TraceShared")
local Protocol = require(TraceShared:WaitForChild("Protocol"))

type Session = Batcher.Session
type Level = Batcher.Level
type RateState = {
	windowStartedAt: number,
	count: number,
	dropped: number,
}

local allowedLevels = {
	trace = true,
	info = true,
	warning = true,
	error = true,
}

local remote = ReplicatedStorage:FindFirstChild(Protocol.RemoteName)
if remote and not remote:IsA("RemoteEvent") then
	error(`[Trace] ReplicatedStorage.{Protocol.RemoteName} must be a RemoteEvent`)
end
if not remote then
	remote = Instance.new("RemoteEvent")
	remote.Name = Protocol.RemoteName
	remote.Parent = ReplicatedStorage
end
local clientLogRemote = remote :: RemoteEvent
local submitFeedbackRemote = TraceShared:WaitForChild("SubmitFeedback") :: RemoteEvent

local batcher = Batcher.new(Config)
local playerSessions: { [Player]: Session } = {}
local rateStates: { [Player]: RateState } = {}
local closing = false

local function nowIso(): string return DateTime.now():ToIsoDate() end

local function createSession(player: Player): Session
	local existingSession = playerSessions[player]
	if existingSession then return existingSession end

	local timestamp = nowIso()
	local session: Session = {
		id = HttpService:GenerateGUID(false),
		playerId = tostring(player.UserId),
		playerName = player.Name,
		playerDisplayName = player.DisplayName,
		startedAt = timestamp,
		lastSeenAt = timestamp,
	}
	playerSessions[player] = session
	batcher:UpdateSession(session)
	return session
end

local function getSession(player: Player): Session return playerSessions[player] or createSession(player) end

local function endSession(player: Player, reason: string)
	local session = playerSessions[player]
	if not session then return end

	local timestamp = nowIso()
	session.lastSeenAt = timestamp
	session.endedAt = timestamp
	session.endReason = reason
	batcher:UpdateSession(session)
	batcher:FinalizeSession(session.id)
	playerSessions[player] = nil
	rateStates[player] = nil
end

local function consumeClientRateLimit(player: Player): (boolean, number)
	local timestamp = os.clock()
	local state = rateStates[player]
	if not state then
		state = {
			windowStartedAt = timestamp,
			count = 0,
			dropped = 0,
		}
		rateStates[player] = state
	elseif timestamp - state.windowStartedAt >= Protocol.ClientRateWindowSeconds then
		state.windowStartedAt = timestamp
		state.count = 0
	end

	if state.count >= Protocol.ClientRateLimit then
		state.dropped += 1
		return false, 0
	end

	state.count += 1
	local dropped = state.dropped
	state.dropped = 0
	return true, dropped
end

local function sanitizeString(value: any, maximumLength: number): string?
	if typeof(value) ~= "string" then return nil end
	return string.sub(value, 1, maximumLength)
end

local function isIgnoredMessage(message: string): boolean
	for _, prefix in Config.IgnoredMessagePrefixes do
		if prefix ~= "" and string.sub(message, 1, #prefix) == prefix then return true end
	end
	return false
end

local function isIdentityCharacter(character: string): boolean
	return character ~= "" and (string.match(character, "[%w_]") ~= nil)
end

local function containsBoundedIdentity(value: string?, identity: string): boolean
	if not value or #identity < 3 then return false end

	local searchFrom = 1
	while true do
		local first, last = string.find(value, identity, searchFrom, true)
		if not first then return false end

		local before = if first > 1 then string.sub(value, first - 1, first - 1) else ""
		local after = if last < #value then string.sub(value, last + 1, last + 1) else ""
		if not isIdentityCharacter(before) and not isIdentityCharacter(after) then return true end
		searchFrom = first + 1
	end
end

local function findReferencedSession(message: string, stack: string?, sourceScript: string?): Session?
	local matchedSession: Session? = nil
	for player, session in playerSessions do
		local userId = tostring(player.UserId)
		local matches = containsBoundedIdentity(message, player.Name)
			or containsBoundedIdentity(stack, player.Name)
			or containsBoundedIdentity(sourceScript, player.Name)
			or containsBoundedIdentity(message, userId)
			or containsBoundedIdentity(stack, userId)
			or containsBoundedIdentity(sourceScript, userId)
		if matches then
			if matchedSession and matchedSession.id ~= session.id then return nil end
			matchedSession = session
		end
	end
	return matchedSession
end

clientLogRemote.OnServerEvent:Connect(function(player, payload)
	if closing or typeof(payload) ~= "table" then return end

	local level = payload.level
	local message = sanitizeString(payload.message, Protocol.MaxMessageLength)
	if typeof(level) ~= "string" or not allowedLevels[level] or not message or message == "" then return end
	if isIgnoredMessage(message) then return end
	level = level :: Level
	local repeatCount = 1
	if typeof(payload.repeatCount) == "number" and payload.repeatCount == payload.repeatCount then
		repeatCount = math.clamp(math.floor(payload.repeatCount), 1, Protocol.MaxRepeatCount)
	end

	local allowed, dropped = consumeClientRateLimit(player)
	if not allowed then return end

	local session = getSession(player)

	local context: { [string]: any } = {
		clientReported = true,
	}
	if dropped > 0 then context.droppedClientLogs = dropped end
	if typeof(payload.context) == "table" then
		local device = sanitizeString(payload.context.device, 32)
		if device then
			context.device = device
			if session.device ~= device then
				session.device = device
				batcher:UpdateSession(session)
			end
		end
	end

	batcher:AddEvent({
		id = HttpService:GenerateGUID(false),
		sessionId = session.id,
		occurredAt = nowIso(),
		source = "client",
		level = level,
		message = message,
		stack = sanitizeString(payload.stack, Protocol.MaxStackLength),
		sourceScript = sanitizeString(payload.sourceScript, Protocol.MaxSourceScriptLength),
		context = context,
		repeatCount = repeatCount,
	})
end)

submitFeedbackRemote.OnServerEvent:Connect(function(player, message)
	if closing or typeof(message) ~= "string" then return end
	local normalized = string.gsub(message, "^%s*(.-)%s*$", "%1")
	local characterCount = utf8.len(normalized)
	if not characterCount or characterCount < 8 or characterCount > 221 then return end
	local session = getSession(player)
	batcher:AddFeedback({
		id = HttpService:GenerateGUID(false),
		sessionId = session.id,
		submittedAt = nowIso(),
		message = normalized,
	})
end)

local serverCollector = LogCollector.new(function(event)
	if isIgnoredMessage(event.message) then return end
	local message = string.sub(event.message, 1, Protocol.MaxMessageLength)
	local stack = sanitizeString(event.stack, Protocol.MaxStackLength)
	local sourceScript = sanitizeString(event.sourceScript, Protocol.MaxSourceScriptLength)
	local referencedSession = findReferencedSession(message, stack, sourceScript)
	batcher:AddEvent({
		id = HttpService:GenerateGUID(false),
		sessionId = if referencedSession then referencedSession.id else nil,
		occurredAt = nowIso(),
		source = "server",
		level = event.level,
		message = message,
		stack = stack,
		sourceScript = sourceScript,
	})
end, {
	captureOutput = Config.CaptureOutputMessages,
})

ScriptContext.Error:Connect(
	function(message, stackTrace, sourceScript) serverCollector:Error(message, stackTrace, sourceScript) end
)

LogService.MessageOut:Connect(function(message, messageType) serverCollector:Message(messageType, message) end)

Players.PlayerAdded:Connect(createSession)
Players.PlayerRemoving:Connect(function(player) endSession(player, "left") end)

for _, player in Players:GetPlayers() do
	createSession(player)
end

batcher:Start()

task.spawn(function()
	while not closing do
		task.wait(Config.HeartbeatIntervalSeconds)
		if closing then break end

		local timestamp = nowIso()
		for _, session in playerSessions do
			session.lastSeenAt = timestamp
			batcher:UpdateSession(session)
		end
	end
end)

game:BindToClose(function()
	closing = true
	for player in playerSessions do
		endSession(player, "server_shutdown")
	end
	batcher:MarkJobEnded()
	batcher:FlushAll(20)
end)
