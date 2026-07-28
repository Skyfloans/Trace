--!strict

local Api = require(script.Parent.Api)
local Theme = require(script.Parent.Theme)

type Palette = Theme.Palette
type ProposalDetail = Api.ProposalDetail
type ProposalList = Api.ProposalList
type ProposalSummary = Api.ProposalSummary

export type Callbacks = {
	onAccept: (proposalId: string) -> (),
	onBack: () -> (),
	onConnect: () -> (),
	onDisconnect: () -> (),
	onOpenProposal: (proposalId: string) -> (),
	onRefresh: () -> (),
	onReject: (proposalId: string) -> (),
	onRetry: (proposalId: string) -> (),
	onStartOver: () -> (),
	onVerify: (code: string) -> (),
}

export type ViewState = {
	kind: "connect" | "loading" | "code" | "reviews" | "detail",
	actionLabel: string?,
	browserUrl: string?,
	errorMessage: string?,
	loadingMessage: string?,
	notice: string?,
	projectName: string?,
	proposal: ProposalDetail?,
	reviews: ProposalList?,
	universeId: string?,
}

local Widget = {}
Widget.__index = Widget

local FONT = Enum.Font.Gotham
local FONT_MEDIUM = Enum.Font.GothamMedium
local FONT_BOLD = Enum.Font.GothamBold
local MONO = Enum.Font.RobotoMono
local MAX_VISIBLE_PROPOSALS = 15

local function addCorner(parent: Instance, radius: number)
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, radius)
	corner.Parent = parent
end

local function addStroke(parent: Instance, color: Color3)
	local stroke = Instance.new("UIStroke")
	stroke.ApplyStrokeMode = Enum.ApplyStrokeMode.Border
	stroke.Color = color
	stroke.Thickness = 1
	stroke.Parent = parent
end

local function addPadding(parent: Instance, horizontal: number, vertical: number)
	local padding = Instance.new("UIPadding")
	padding.PaddingBottom = UDim.new(0, vertical)
	padding.PaddingLeft = UDim.new(0, horizontal)
	padding.PaddingRight = UDim.new(0, horizontal)
	padding.PaddingTop = UDim.new(0, vertical)
	padding.Parent = parent
end

local function createLabel(
	parent: Instance,
	text: string,
	textSize: number,
	color: Color3,
	font: Enum.Font,
	order: number
): TextLabel
	local label = Instance.new("TextLabel")
	label.Name = "Label"
	label.AutomaticSize = Enum.AutomaticSize.Y
	label.BackgroundTransparency = 1
	label.Font = font
	label.LayoutOrder = order
	label.Size = UDim2.new(1, 0, 0, 0)
	label.Text = text
	label.TextColor3 = color
	label.TextSize = textSize
	label.TextWrapped = true
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.TextYAlignment = Enum.TextYAlignment.Top
	label.Parent = parent
	return label
end

local function createSpacer(parent: Instance, height: number, order: number)
	local spacer = Instance.new("Frame")
	spacer.Name = "Spacer"
	spacer.BackgroundTransparency = 1
	spacer.LayoutOrder = order
	spacer.Size = UDim2.new(1, 0, 0, height)
	spacer.Parent = parent
end

local function createButton(
	parent: Instance,
	text: string,
	kind: "primary" | "secondary" | "quiet" | "danger",
	palette: Palette,
	order: number
): TextButton
	local button = Instance.new("TextButton")
	button.Name = "Action"
	button.AutoButtonColor = false
	button.Font = FONT_MEDIUM
	button.LayoutOrder = order
	button.Size = UDim2.new(1, 0, 0, if kind == "quiet" then 32 else 38)
	button.Text = text
	button.TextSize = 13

	if kind == "primary" then
		button.BackgroundColor3 = palette.accent
		button.TextColor3 = palette.accentInk
	elseif kind == "secondary" then
		button.BackgroundColor3 = palette.button
		button.TextColor3 = palette.text
		addStroke(button, palette.border)
	elseif kind == "danger" then
		button.BackgroundColor3 = palette.error:Lerp(palette.main, 0.8)
		button.TextColor3 = palette.error
		addStroke(button, palette.error:Lerp(palette.main, 0.5))
	else
		button.BackgroundTransparency = 1
		button.TextColor3 = palette.muted
	end
	addCorner(button, 7)

	button.MouseEnter:Connect(function()
		if not button.Active then return end
		if kind == "primary" then
			button.BackgroundColor3 = palette.accentHover
		elseif kind == "secondary" then
			button.BackgroundColor3 = palette.buttonHover
		elseif kind == "quiet" then
			button.TextColor3 = palette.text
		end
	end)
	button.MouseLeave:Connect(function()
		if kind == "primary" then
			button.BackgroundColor3 = palette.accent
		elseif kind == "secondary" then
			button.BackgroundColor3 = palette.button
		elseif kind == "quiet" then
			button.TextColor3 = palette.muted
		end
	end)
	button.MouseButton1Down:Connect(function()
		if kind == "secondary" then button.BackgroundColor3 = palette.buttonPressed end
	end)
	button.Parent = parent
	return button
end

local function createHeader(parent: Instance, palette: Palette, logoImage: string, order: number)
	local header = Instance.new("Frame")
	header.Name = "Header"
	header.BackgroundTransparency = 1
	header.LayoutOrder = order
	header.Size = UDim2.new(1, 0, 0, 43)
	header.Parent = parent

	if logoImage ~= "" then
		local logo = Instance.new("ImageLabel")
		logo.Name = "TraceLogo"
		logo.BackgroundTransparency = 1
		logo.Image = logoImage
		logo.Position = UDim2.fromOffset(0, 2)
		logo.Size = UDim2.fromOffset(36, 36)
		logo.ScaleType = Enum.ScaleType.Fit
		logo.Parent = header
	else
		local markText = Instance.new("TextLabel")
		markText.BackgroundTransparency = 1
		markText.Font = FONT_BOLD
		markText.Position = UDim2.fromOffset(0, 2)
		markText.Size = UDim2.fromOffset(36, 36)
		markText.Text = "t"
		markText.TextColor3 = palette.accent
		markText.TextSize = 20
		markText.Parent = header
	end

	local brand = Instance.new("TextLabel")
	brand.BackgroundTransparency = 1
	brand.Font = FONT_BOLD
	brand.Position = UDim2.fromOffset(45, 0)
	brand.Size = UDim2.new(1, -45, 0, 23)
	brand.Text = "trace"
	brand.TextColor3 = palette.text
	brand.TextSize = 17
	brand.TextXAlignment = Enum.TextXAlignment.Left
	brand.Parent = header

	local product = Instance.new("TextLabel")
	product.BackgroundTransparency = 1
	product.Font = FONT_MEDIUM
	product.Position = UDim2.fromOffset(45, 22)
	product.Size = UDim2.new(1, -45, 0, 16)
	product.Text = "Autofix for Studio"
	product.TextColor3 = palette.accent
	product.TextSize = 10
	product.TextXAlignment = Enum.TextXAlignment.Left
	product.Parent = header
end

local function createMessage(
	parent: Instance,
	palette: Palette,
	text: string,
	tone: "error" | "success" | "info",
	order: number
)
	local color = if tone == "error" then palette.error elseif tone == "success" then palette.success else palette.muted
	local message = Instance.new("TextLabel")
	message.Name = "Message"
	message.AutomaticSize = Enum.AutomaticSize.Y
	message.BackgroundColor3 = color:Lerp(palette.main, 0.84)
	message.Font = FONT
	message.LayoutOrder = order
	message.Size = UDim2.new(1, 0, 0, 0)
	message.Text = (if tone == "error" then "!  " elseif tone == "success" then "✓  " else "") .. text
	message.TextColor3 = color
	message.TextSize = 11
	message.TextWrapped = true
	message.TextXAlignment = Enum.TextXAlignment.Left
	addCorner(message, 6)
	addStroke(message, color:Lerp(palette.main, 0.58))
	addPadding(message, 10, 9)
	message.Parent = parent
end

local function createContextCard(
	parent: Instance,
	palette: Palette,
	labelText: string,
	valueText: string,
	order: number
)
	local card = Instance.new("Frame")
	card.Name = "Context"
	card.BackgroundColor3 = palette.raised
	card.LayoutOrder = order
	card.Size = UDim2.new(1, 0, 0, 54)
	addCorner(card, 7)
	addStroke(card, palette.border)
	card.Parent = parent

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = FONT
	label.Position = UDim2.fromOffset(11, 7)
	label.Size = UDim2.new(1, -22, 0, 16)
	label.Text = labelText
	label.TextColor3 = palette.muted
	label.TextSize = 10
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.Parent = card

	local value = Instance.new("TextLabel")
	value.BackgroundTransparency = 1
	value.Font = MONO
	value.Position = UDim2.fromOffset(11, 25)
	value.Size = UDim2.new(1, -22, 0, 20)
	value.Text = valueText
	value.TextColor3 = palette.text
	value.TextSize = 12
	value.TextTruncate = Enum.TextTruncate.AtEnd
	value.TextXAlignment = Enum.TextXAlignment.Left
	value.Parent = card
end

local function categoryColor(palette: Palette, category: string): Color3
	if category == "critical" then
		return palette.error
	elseif category == "high" then
		return palette.accent
	elseif category == "medium" then
		return Color3.fromRGB(229, 184, 102)
	else
		return palette.muted
	end
end

local function createPill(parent: Instance, text: string, color: Color3, order: number): TextLabel
	local pill = Instance.new("TextLabel")
	pill.AutomaticSize = Enum.AutomaticSize.X
	pill.BackgroundColor3 = color:Lerp(Theme.read().main, 0.78)
	pill.Font = FONT_MEDIUM
	pill.LayoutOrder = order
	pill.Size = UDim2.fromOffset(0, 20)
	pill.Text = string.upper(text)
	pill.TextColor3 = color
	pill.TextSize = 9
	addCorner(pill, 5)
	addPadding(pill, 7, 0)
	pill.Parent = parent
	return pill
end

local function reviewStatusText(status: string): string
	if status == "ready" then
		return "Ready to review"
	elseif status == "processing" then
		return "Preparing fix…"
	elseif status == "queued" then
		return "Queued"
	elseif status == "conflict" then
		return "Needs another look"
	elseif status == "unable" then
		return "Needs investigation"
	elseif status == "failed" then
		return "Preparation failed"
	end
	return status
end

local function createProposalCard(
	parent: Instance,
	palette: Palette,
	proposal: ProposalSummary,
	order: number,
	onOpen: (string) -> ()
)
	local card = Instance.new("TextButton")
	card.Name = "FixRequest"
	card.AutoButtonColor = false
	card.BackgroundColor3 = palette.raised
	card.LayoutOrder = order
	card.Size = UDim2.new(1, 0, 0, 106)
	card.Text = ""
	addCorner(card, 8)
	addStroke(card, palette.border)
	card.Parent = parent

	local category = createPill(card, proposal.category, categoryColor(palette, proposal.category), 0)
	category.Position = UDim2.fromOffset(11, 10)

	local status = Instance.new("TextLabel")
	status.BackgroundTransparency = 1
	status.Font = FONT
	status.Position = UDim2.new(0.45, 0, 0, 10)
	status.Size = UDim2.new(0.55, -12, 0, 20)
	status.Text = reviewStatusText(proposal.status)
	status.TextColor3 = if proposal.status == "ready" then palette.success else palette.muted
	status.TextSize = 10
	status.TextXAlignment = Enum.TextXAlignment.Right
	status.Parent = card

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Font = FONT_MEDIUM
	title.Position = UDim2.fromOffset(11, 38)
	title.Size = UDim2.new(1, -30, 0, 22)
	title.Text = proposal.title or proposal.message
	title.TextColor3 = palette.text
	title.TextSize = 13
	title.TextTruncate = Enum.TextTruncate.AtEnd
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Parent = card

	local meta = Instance.new("TextLabel")
	meta.BackgroundTransparency = 1
	meta.Font = FONT
	meta.Position = UDim2.fromOffset(11, 65)
	meta.Size = UDim2.new(1, -32, 0, 30)
	if proposal.fileCount > 0 then
		meta.Text = string.format(
			"%s  ·  %d event%s  ·  %d file%s",
			proposal.sourceScript or "Unknown script",
			proposal.eventCount,
			if proposal.eventCount == 1 then "" else "s",
			proposal.fileCount,
			if proposal.fileCount == 1 then "" else "s"
		)
	else
		meta.Text = string.format(
			"%s  ·  %d event%s  ·  No change prepared",
			proposal.sourceScript or "Unknown script",
			proposal.eventCount,
			if proposal.eventCount == 1 then "" else "s"
		)
	end
	meta.TextColor3 = palette.muted
	meta.TextSize = 10
	meta.TextTruncate = Enum.TextTruncate.AtEnd
	meta.TextXAlignment = Enum.TextXAlignment.Left
	meta.Parent = card

	local arrow = Instance.new("TextLabel")
	arrow.BackgroundTransparency = 1
	arrow.Font = FONT_MEDIUM
	arrow.Position = UDim2.new(1, -23, 0, 40)
	arrow.Size = UDim2.fromOffset(12, 22)
	arrow.Text = "›"
	arrow.TextColor3 = palette.muted
	arrow.TextSize = 18
	arrow.Parent = card

	card.MouseEnter:Connect(function() card.BackgroundColor3 = palette.buttonHover end)
	card.MouseLeave:Connect(function() card.BackgroundColor3 = palette.raised end)
	card.MouseButton1Click:Connect(function() onOpen(proposal.id) end)
end

local function createDiff(parent: Instance, palette: Palette, file: Api.ProposalFile, order: number)
	local lineCount = 0
	for _, hunk in file.patch.hunks do
		lineCount += #hunk.lines + 1
	end
	local frame = Instance.new("Frame")
	frame.Name = "ScriptDiff"
	frame.BackgroundColor3 = Color3.fromRGB(31, 41, 56)
	frame.ClipsDescendants = true
	frame.LayoutOrder = order
	frame.Size = UDim2.new(1, 0, 0, 39 + lineCount * 21)
	addCorner(frame, 7)
	addStroke(frame, palette.border)
	frame.Parent = parent

	local filename = Instance.new("TextLabel")
	filename.BackgroundColor3 = Color3.fromRGB(42, 54, 73)
	filename.BorderSizePixel = 0
	filename.Font = MONO
	filename.Position = UDim2.fromOffset(0, 0)
	filename.Size = UDim2.new(1, 0, 0, 34)
	filename.Text = "  " .. file.path
	filename.TextColor3 = Color3.fromRGB(190, 204, 226)
	filename.TextSize = 10
	filename.TextTruncate = Enum.TextTruncate.AtEnd
	filename.TextXAlignment = Enum.TextXAlignment.Left
	filename.Parent = frame

	local y = 34
	for _, hunk in file.patch.hunks do
		local hunkTitle = Instance.new("TextLabel")
		hunkTitle.BackgroundColor3 = Color3.fromRGB(42, 54, 73)
		hunkTitle.BorderSizePixel = 0
		hunkTitle.Font = FONT_MEDIUM
		hunkTitle.Position = UDim2.fromOffset(0, y)
		hunkTitle.Size = UDim2.new(1, 0, 0, 21)
		hunkTitle.Text =
			string.format("  Hunk · Lines %d–%d", hunk.oldStart, hunk.oldStart + math.max(0, hunk.oldLines - 1))
		hunkTitle.TextColor3 = Color3.fromRGB(151, 171, 203)
		hunkTitle.TextSize = 10
		hunkTitle.TextXAlignment = Enum.TextXAlignment.Left
		hunkTitle.Parent = frame
		y += 21

		local oldLine = hunk.oldStart
		local newLine = hunk.newStart
		for _, rawLine in hunk.lines do
			if rawLine == "\\ No newline at end of file" then continue end
			local prefix = string.sub(rawLine, 1, 1)
			local codeText = string.sub(rawLine, 2)
			local row = Instance.new("Frame")
			row.BorderSizePixel = 0
			row.Position = UDim2.fromOffset(0, y)
			row.Size = UDim2.new(1, 0, 0, 21)
			if prefix == "-" then
				row.BackgroundColor3 = Color3.fromRGB(102, 48, 52)
			elseif prefix == "+" then
				row.BackgroundColor3 = Color3.fromRGB(5, 91, 94)
			else
				row.BackgroundTransparency = 1
			end
			row.Parent = frame

			local oldNumber = if prefix == "+" then "" else tostring(oldLine)
			local newNumber = if prefix == "-" then "" else tostring(newLine)
			if prefix ~= "+" then
				oldLine += 1
			end
			if prefix ~= "-" then
				newLine += 1
			end

			local numbers = Instance.new("TextLabel")
			numbers.BackgroundTransparency = 1
			numbers.Font = MONO
			numbers.Size = UDim2.fromOffset(58, 21)
			numbers.Text = string.format("%3s %3s", oldNumber, newNumber)
			numbers.TextColor3 = Color3.fromRGB(108, 128, 159)
			numbers.TextSize = 9
			numbers.Parent = row

			local code = Instance.new("TextLabel")
			code.BackgroundTransparency = 1
			code.Font = MONO
			code.Position = UDim2.fromOffset(64, 0)
			code.Size = UDim2.new(1, -68, 0, 21)
			code.Text = (if prefix == " " then "  " else prefix .. " ") .. codeText
			code.TextColor3 = if prefix == "-"
				then Color3.fromRGB(255, 171, 149)
				elseif prefix == "+" then Color3.fromRGB(73, 205, 158)
				else Color3.fromRGB(236, 240, 247)
			code.TextSize = 10
			code.TextTruncate = Enum.TextTruncate.AtEnd
			code.TextXAlignment = Enum.TextXAlignment.Left
			code.Parent = row
			y += 21
		end
	end
end

function Widget.new(plugin: Plugin, callbacks: Callbacks, logoImage: string)
	local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 440, 600, 340, 390)
	local dockWidget = plugin:CreateDockWidgetPluginGuiAsync("TraceAutofixAuthentication", widgetInfo)
	dockWidget.Name = "TraceAutofix"
	dockWidget.Title = "Trace Autofix"
	dockWidget.ZIndexBehavior = Enum.ZIndexBehavior.Sibling

	local scrolling = Instance.new("ScrollingFrame")
	scrolling.Name = "Content"
	scrolling.AutomaticCanvasSize = Enum.AutomaticSize.Y
	scrolling.BackgroundTransparency = 1
	scrolling.BorderSizePixel = 0
	scrolling.CanvasSize = UDim2.new()
	scrolling.ScrollBarThickness = 4
	scrolling.Size = UDim2.fromScale(1, 1)
	scrolling.Parent = dockWidget

	local content = Instance.new("Frame")
	content.Name = "Layout"
	content.AutomaticSize = Enum.AutomaticSize.Y
	content.BackgroundTransparency = 1
	content.Position = UDim2.fromOffset(14, 14)
	content.Size = UDim2.new(1, -28, 0, 0)
	content.Parent = scrolling

	local list = Instance.new("UIListLayout")
	list.Padding = UDim.new(0, 9)
	list.SortOrder = Enum.SortOrder.LayoutOrder
	list.Parent = content

	local self = setmetatable({
		callbacks = callbacks,
		content = content,
		dockWidget = dockWidget,
		logoImage = logoImage,
		state = {
			kind = "connect",
		} :: ViewState,
	}, Widget)

	settings().Studio.ThemeChanged:Connect(function() self:_render() end)
	return self
end

function Widget:setEnabled(enabled: boolean) self.dockWidget.Enabled = enabled end

function Widget:isEnabled(): boolean return self.dockWidget.Enabled end

function Widget:onEnabledChanged(callback: () -> ())
	self.dockWidget:GetPropertyChangedSignal("Enabled"):Connect(callback)
end

function Widget:setState(state: ViewState)
	self.state = state
	self:_render()
end

function Widget:_clear()
	for _, child in self.content:GetChildren() do
		if not child:IsA("UIListLayout") then child:Destroy() end
	end
end

function Widget:_renderConnect(palette: Palette)
	createLabel(self.content, "Connect Trace", 18, palette.text, FONT_MEDIUM, 10)
	createLabel(
		self.content,
		"Review AI-prepared bug fixes and apply them only after you approve the script diff.",
		12,
		palette.muted,
		FONT,
		20
	)
	createSpacer(self.content, 2, 25)
	createContextCard(self.content, palette, "CURRENT STUDIO EXPERIENCE", self.state.universeId or "Not published", 30)
	if self.state.errorMessage then createMessage(self.content, palette, self.state.errorMessage, "error", 40) end
	local connectButton =
		createButton(self.content, self.state.actionLabel or "Connect to Trace", "primary", palette, 50)
	connectButton.MouseButton1Click:Connect(self.callbacks.onConnect)
	createLabel(
		self.content,
		"Trace verifies your Roblox account and this experience before showing fixes.",
		10,
		palette.muted,
		FONT,
		60
	)
end

function Widget:_renderLoading(palette: Palette)
	createLabel(self.content, "One moment", 18, palette.text, FONT_MEDIUM, 10)
	createMessage(self.content, palette, self.state.loadingMessage or "Contacting Trace…", "info", 20)
end

function Widget:_renderCode(palette: Palette)
	createLabel(self.content, "Verify this Studio", 18, palette.text, FONT_MEDIUM, 10)
	createLabel(
		self.content,
		"Copy this secure link into your browser, authorize the request on Trace, then enter the two-digit code.",
		12,
		palette.muted,
		FONT,
		20
	)

	local browserUrl = self.state.browserUrl or "https://tracestack.gg"
	local link = Instance.new("TextBox")
	link.Name = "ConnectionLink"
	link.BackgroundColor3 = palette.input
	link.ClearTextOnFocus = false
	link.Font = MONO
	link.LayoutOrder = 30
	link.Size = UDim2.new(1, 0, 0, 40)
	link.Text = browserUrl
	link.TextColor3 = palette.text
	link.TextSize = 10
	link.TextTruncate = Enum.TextTruncate.AtEnd
	link.TextXAlignment = Enum.TextXAlignment.Left
	addCorner(link, 7)
	addStroke(link, palette.inputBorder)
	addPadding(link, 10, 0)
	link.Parent = self.content
	link.FocusLost:Connect(function() link.Text = browserUrl end)

	local selectLink = createButton(self.content, "Select connection link", "secondary", palette, 40)
	selectLink.MouseButton1Click:Connect(function()
		link:CaptureFocus()
		link.CursorPosition = #browserUrl + 1
		link.SelectionStart = 1
	end)
	createLabel(self.content, "Press ⌘C or Ctrl+C, then paste it into your browser.", 10, palette.muted, FONT, 45)
	createLabel(self.content, "TWO-DIGIT CODE", 10, palette.muted, FONT_MEDIUM, 50)

	local code = Instance.new("TextBox")
	code.Name = "PairingCode"
	code.BackgroundColor3 = palette.input
	code.ClearTextOnFocus = false
	code.Font = MONO
	code.LayoutOrder = 60
	code.PlaceholderText = "••"
	code.PlaceholderColor3 = palette.muted
	code.Size = UDim2.new(1, 0, 0, 52)
	code.Text = ""
	code.TextColor3 = palette.text
	code.TextSize = 24
	code.TextXAlignment = Enum.TextXAlignment.Center
	addCorner(code, 7)
	addStroke(code, palette.inputBorder)
	code.Parent = self.content
	code:GetPropertyChangedSignal("Text"):Connect(function()
		local digits = string.sub(string.gsub(code.Text, "%D", ""), 1, 2)
		if code.Text ~= digits then code.Text = digits end
	end)

	if self.state.errorMessage then createMessage(self.content, palette, self.state.errorMessage, "error", 70) end
	local verify = createButton(self.content, self.state.actionLabel or "Verify and connect", "primary", palette, 80)
	local function submit()
		if #code.Text == 2 then self.callbacks.onVerify(code.Text) end
	end
	verify.MouseButton1Click:Connect(submit)
	code.FocusLost:Connect(function(enterPressed)
		if enterPressed then submit() end
	end)
	local startOver = createButton(self.content, "Start over", "quiet", palette, 90)
	startOver.MouseButton1Click:Connect(self.callbacks.onStartOver)
end

function Widget:_renderReviews(palette: Palette)
	local connected = Instance.new("Frame")
	connected.BackgroundColor3 = palette.success:Lerp(palette.main, 0.86)
	connected.LayoutOrder = 10
	connected.Size = UDim2.new(1, 0, 0, 38)
	addCorner(connected, 7)
	addStroke(connected, palette.success:Lerp(palette.main, 0.58))
	connected.Parent = self.content

	local connectedText = Instance.new("TextLabel")
	connectedText.BackgroundTransparency = 1
	connectedText.Font = FONT
	connectedText.Position = UDim2.fromOffset(10, 0)
	connectedText.Size = UDim2.new(1, -100, 1, 0)
	connectedText.Text = "✓  " .. (self.state.projectName or "Connected to Trace")
	connectedText.TextColor3 = palette.success
	connectedText.TextSize = 11
	connectedText.TextTruncate = Enum.TextTruncate.AtEnd
	connectedText.TextXAlignment = Enum.TextXAlignment.Left
	connectedText.Parent = connected

	local disconnect = Instance.new("TextButton")
	disconnect.BackgroundTransparency = 1
	disconnect.Font = FONT_MEDIUM
	disconnect.Position = UDim2.new(1, -86, 0, 0)
	disconnect.Size = UDim2.fromOffset(76, 38)
	disconnect.Text = "Disconnect"
	disconnect.TextColor3 = palette.muted
	disconnect.TextSize = 10
	disconnect.Parent = connected
	disconnect.MouseButton1Click:Connect(self.callbacks.onDisconnect)

	local heading = Instance.new("Frame")
	heading.BackgroundTransparency = 1
	heading.LayoutOrder = 20
	heading.Size = UDim2.new(1, 0, 0, 34)
	heading.Parent = self.content
	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Font = FONT_MEDIUM
	title.Size = UDim2.new(1, -72, 1, 0)
	title.Text = "Fix requests"
	title.TextColor3 = palette.text
	title.TextSize = 18
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Parent = heading
	local refresh = Instance.new("TextButton")
	refresh.BackgroundColor3 = palette.button
	refresh.Font = FONT_MEDIUM
	refresh.Position = UDim2.new(1, -64, 0, 1)
	refresh.Size = UDim2.fromOffset(64, 32)
	refresh.Text = "Refresh"
	refresh.TextColor3 = palette.text
	refresh.TextSize = 10
	addCorner(refresh, 7)
	addStroke(refresh, palette.border)
	refresh.Parent = heading
	refresh.MouseButton1Click:Connect(self.callbacks.onRefresh)

	if self.state.errorMessage then createMessage(self.content, palette, self.state.errorMessage, "error", 25) end
	if self.state.notice then createMessage(self.content, palette, self.state.notice, "success", 26) end

	local reviews = self.state.reviews
	if not reviews then
		createMessage(self.content, palette, "Loading fix requests…", "info", 30)
		return
	end

	if reviews.run and (reviews.run.status == "queued" or reviews.run.status == "processing") then
		createMessage(
			self.content,
			palette,
			"Preparing up to " .. tostring(reviews.run.maxProposals) .. " fixes, one bug at a time…",
			"info",
			30
		)
	elseif reviews.run and reviews.run.status == "failed" then
		createMessage(self.content, palette, reviews.run.error or "The latest fix batch failed.", "error", 30)
	elseif not reviews.available then
		createMessage(
			self.content,
			palette,
			"Autofix is paused until OpenRouter and place snapshot storage are configured.",
			"info",
			30
		)
	else
		createMessage(
			self.content,
			palette,
			"Trace checks priority bugs automatically every 10 minutes and keeps at most 15 unresolved requests.",
			"info",
			30
		)
	end

	if #reviews.proposals == 0 then
		local empty = Instance.new("Frame")
		empty.BackgroundColor3 = palette.raised
		empty.LayoutOrder = 40
		empty.Size = UDim2.new(1, 0, 0, 112)
		addCorner(empty, 8)
		addStroke(empty, palette.border)
		empty.Parent = self.content
		local emptyTitle = createLabel(empty, "No fix requests yet", 14, palette.text, FONT_MEDIUM, 0)
		emptyTitle.Position = UDim2.fromOffset(14, 18)
		emptyTitle.Size = UDim2.new(1, -28, 0, 22)
		local emptyBody = createLabel(
			empty,
			"Trace is watching the priority list. New review requests will appear here automatically.",
			11,
			palette.muted,
			FONT,
			0
		)
		emptyBody.Position = UDim2.fromOffset(14, 48)
		emptyBody.Size = UDim2.new(1, -28, 0, 45)
		return
	end

	for index, proposal in reviews.proposals do
		if index > MAX_VISIBLE_PROPOSALS then break end
		createProposalCard(self.content, palette, proposal, 50 + index, self.callbacks.onOpenProposal)
	end
end

function Widget:_renderDetail(palette: Palette)
	local proposal = self.state.proposal
	local back = createButton(self.content, "‹  Back to fix requests", "quiet", palette, 10)
	back.TextXAlignment = Enum.TextXAlignment.Left
	back.MouseButton1Click:Connect(self.callbacks.onBack)
	if not proposal then
		createMessage(self.content, palette, "Loading the proposed change…", "info", 20)
		return
	end

	createPill(self.content, proposal.category, categoryColor(palette, proposal.category), 20)
	createLabel(self.content, proposal.title or proposal.bug.message, 18, palette.text, FONT_MEDIUM, 30)
	if proposal.summary then createLabel(self.content, proposal.summary, 11, palette.muted, FONT, 40) end
	if self.state.errorMessage then createMessage(self.content, palette, self.state.errorMessage, "error", 45) end
	if self.state.notice then createMessage(self.content, palette, self.state.notice, "success", 46) end
	if proposal.status == "queued" or proposal.status == "processing" then
		createMessage(
			self.content,
			palette,
			if proposal.status == "queued"
				then "This request is queued. Trace will prepare its code change shortly."
				else "Trace is reading the relevant scripts and preparing a code change.",
			"info",
			47
		)
		return
	end
	if proposal.status == "unable" or proposal.status == "failed" then
		createLabel(self.content, "No reviewable code change", 14, palette.text, FONT_MEDIUM, 47)
		createMessage(
			self.content,
			palette,
			proposal.failureReason
				or if proposal.status == "failed"
					then "Trace encountered an error before it could prepare a code change."
					else "Trace did not have enough source evidence to prepare a safe change.",
			if proposal.status == "failed" then "error" else "info",
			48
		)
		local retry = createButton(self.content, "Retry investigation", "secondary", palette, 80)
		retry.MouseButton1Click:Connect(function() self.callbacks.onRetry(proposal.id) end)
		local dismiss = createButton(self.content, "Dismiss request", "quiet", palette, 90)
		dismiss.MouseButton1Click:Connect(function() self.callbacks.onReject(proposal.id) end)
		createLabel(
			self.content,
			"No Studio scripts were changed. A diff appears only after Trace prepares a concrete edit.",
			9,
			palette.muted,
			FONT,
			100
		)
		return
	end
	if proposal.status == "conflict" then
		createMessage(
			self.content,
			palette,
			proposal.failureReason or "Studio has newer edits near this patch. No scripts were changed.",
			"error",
			47
		)
	end

	for index, file in proposal.files do
		createDiff(self.content, palette, file, 50 + index)
	end
	if #proposal.files == 0 then
		createMessage(
			self.content,
			palette,
			"Trace marked this request reviewable without attaching a script change. Refresh the request or dismiss it.",
			"error",
			55
		)
	end

	if proposal.status == "ready" or proposal.status == "conflict" then
		local accept = createButton(self.content, "Accept and apply changes", "primary", palette, 80)
		accept.MouseButton1Click:Connect(function() self.callbacks.onAccept(proposal.id) end)
		local retry = createButton(self.content, "Regenerate root-cause fix", "secondary", palette, 85)
		retry.MouseButton1Click:Connect(function() self.callbacks.onRetry(proposal.id) end)
		local reject = createButton(self.content, "Reject proposal", "danger", palette, 90)
		reject.MouseButton1Click:Connect(function() self.callbacks.onReject(proposal.id) end)
	end
	if #proposal.files > 0 then
		createLabel(
			self.content,
			"Applied edits are recorded as one Studio undo action. Trace never publishes the place.",
			9,
			palette.muted,
			FONT,
			100
		)
	end
end

function Widget:_render()
	self:_clear()
	local palette = Theme.read()
	local scrolling = self.content.Parent :: ScrollingFrame
	scrolling.BackgroundColor3 = palette.main
	createHeader(self.content, palette, self.logoImage, 0)

	if self.state.kind == "connect" then
		self:_renderConnect(palette)
	elseif self.state.kind == "loading" then
		self:_renderLoading(palette)
	elseif self.state.kind == "code" then
		self:_renderCode(palette)
	elseif self.state.kind == "reviews" then
		self:_renderReviews(palette)
	elseif self.state.kind == "detail" then
		self:_renderDetail(palette)
	end
end

return Widget
