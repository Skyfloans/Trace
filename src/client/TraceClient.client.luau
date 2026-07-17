local LogService = game:GetService("LogService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ScriptContext = game:GetService("ScriptContext")
local UserInputService = game:GetService("UserInputService")

local TraceShared = ReplicatedStorage:WaitForChild("TraceShared")
local LogCollector = require(TraceShared:WaitForChild("LogCollector"))
local Protocol = require(TraceShared:WaitForChild("Protocol"))
local remote = ReplicatedStorage:WaitForChild(Protocol.RemoteName)

type PendingEvent = {
	level: string,
	message: string,
	stack: string?,
	sourceScript: string?,
	repeatCount: number,
}

local function truncate(value: string?, maximumLength: number): string?
	if not value then return nil end
	return string.sub(value, 1, maximumLength)
end

local function getDeviceType(): string
	if UserInputService.TouchEnabled and not UserInputService.KeyboardEnabled then return "mobile" end
	if UserInputService.GamepadEnabled and not UserInputService.KeyboardEnabled then return "console" end
	return "desktop"
end

local pendingEvents: { [string]: PendingEvent } = {}
local pendingEventCount = 0
local deviceType = getDeviceType()

local function flushPendingEvents()
	local events = pendingEvents
	pendingEvents = {}
	pendingEventCount = 0

	for _, event in events do
		pcall(remote.FireServer, remote, {
			level = event.level,
			message = event.message,
			stack = event.stack,
			sourceScript = event.sourceScript,
			repeatCount = event.repeatCount,
			context = {
				device = deviceType,
			},
		})
	end
end

local collector = LogCollector.new(function(event)
	local message = truncate(event.message, Protocol.MaxMessageLength)
	if not message then return end
	local sourceScript = truncate(event.sourceScript, Protocol.MaxSourceScriptLength)
	local aggregationKey = table.concat({
		event.level,
		sourceScript or "",
		message,
	}, "\0")
	local pending = pendingEvents[aggregationKey]
	if pending then
		pending.repeatCount = math.min(pending.repeatCount + 1, Protocol.MaxRepeatCount)
		return
	end
	if pendingEventCount >= Protocol.MaxPendingClientGroups then return end

	pendingEvents[aggregationKey] = {
		level = event.level,
		message = message,
		stack = truncate(event.stack, Protocol.MaxStackLength),
		sourceScript = sourceScript,
		repeatCount = 1,
	}
	pendingEventCount += 1
end)

task.spawn(function()
	while true do
		task.wait(Protocol.ClientFlushIntervalSeconds)
		flushPendingEvents()
	end
end)

Players.PlayerRemoving:Connect(function(player)
	if player == Players.LocalPlayer then flushPendingEvents() end
end)

ScriptContext.Error:Connect(
	function(message, stackTrace, sourceScript) collector:Error(message, stackTrace, sourceScript) end
)

LogService.MessageOut:Connect(function(message, messageType) collector:Message(messageType, message) end)
