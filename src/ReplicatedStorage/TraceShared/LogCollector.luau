export type Level = "trace" | "info" | "warning" | "error"

export type LogEvent = {
	level: Level,
	message: string,
	stack: string?,
	sourceScript: string?,
}

type WarningEntry = {
	message: string,
	stack: { string },
	collectingStack: boolean,
	completed: boolean,
}

type CollectorOptions = {
	captureOutput: boolean?,
}

type Collector = {
	_pendingWarnings: { WarningEntry },
	_activeWarning: WarningEntry?,
	_emit: (LogEvent) -> (),
	_captureOutput: boolean,
	Error: (self: Collector, message: string, stackTrace: string, sourceScript: LuaSourceContainer?) -> (),
	Message: (self: Collector, messageType: Enum.MessageType, message: string) -> (),
	_finishWarning: (self: Collector, entry: WarningEntry) -> (),
}

local INTERNAL_PREFIX = "[Trace]"
local WARNING_STACK_WAIT_SECONDS = 0.5

local LogCollector = {}
LogCollector.__index = LogCollector

local function getSourceName(sourceScript: LuaSourceContainer?): string?
	if not sourceScript then return nil end

	local success, fullName = pcall(sourceScript.GetFullName, sourceScript)
	if success then return fullName end

	return sourceScript.Name
end

function LogCollector.new(emit: (LogEvent) -> (), options: CollectorOptions?): Collector
	local self = setmetatable({
		_pendingWarnings = {},
		_activeWarning = nil,
		_emit = emit,
		_captureOutput = options and options.captureOutput == true or false,
	}, LogCollector)

	return self :: any
end

function LogCollector:Error(message: string, stackTrace: string, sourceScript: LuaSourceContainer?)
	if string.sub(message, 1, #INTERNAL_PREFIX) == INTERNAL_PREFIX then return end

	self._emit({
		level = "error",
		message = message,
		stack = stackTrace,
		sourceScript = getSourceName(sourceScript),
	})
end

function LogCollector:_finishWarning(entry: WarningEntry)
	if entry.completed then return end

	entry.completed = true
	self._emit({
		level = "warning",
		message = entry.message,
		stack = if #entry.stack > 0 then table.concat(entry.stack, "\n") else nil,
	})
end

function LogCollector:Message(messageType: Enum.MessageType, message: string)
	if string.sub(message, 1, #INTERNAL_PREFIX) == INTERNAL_PREFIX then return end

	if messageType == Enum.MessageType.MessageError then return end

	if messageType == Enum.MessageType.MessageWarning then
		local entry: WarningEntry = {
			message = message,
			stack = {},
			collectingStack = false,
			completed = false,
		}
		table.insert(self._pendingWarnings, entry)

		task.delay(WARNING_STACK_WAIT_SECONDS, function()
			if entry.completed or entry.collectingStack then return end

			local index = table.find(self._pendingWarnings, entry)
			if index then table.remove(self._pendingWarnings, index) end
			self:_finishWarning(entry)
		end)
		return
	end

	if message == "Stack Begin" then
		local entry = table.remove(self._pendingWarnings, 1)
		if entry then
			entry.collectingStack = true
			self._activeWarning = entry
		end
		return
	end

	if message == "Stack End" then
		local entry = self._activeWarning
		self._activeWarning = nil
		if entry then self:_finishWarning(entry) end
		return
	end

	local activeWarning = self._activeWarning
	if activeWarning then
		table.insert(activeWarning.stack, message)
		return
	end

	if self._captureOutput then self._emit({
		level = "info",
		message = message,
	}) end
end

return LogCollector
