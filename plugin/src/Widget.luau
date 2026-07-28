--!strict

local Theme = require(script.Parent.Theme)

type Palette = Theme.Palette

export type Callbacks = {
	onConnect: () -> (),
	onDisconnect: () -> (),
	onStartOver: () -> (),
	onVerify: (code: string) -> (),
}

export type ViewState = {
	kind: "connect" | "loading" | "code" | "connected",
	actionLabel: string?,
	browserUrl: string?,
	errorMessage: string?,
	loadingMessage: string?,
	placeId: string?,
	projectName: string?,
	sourceUniverseId: string?,
	targetUniverseId: string?,
	universeId: string?,
}

local Widget = {}
Widget.__index = Widget

local FONT = Enum.Font.Gotham
local FONT_MEDIUM = Enum.Font.GothamMedium
local FONT_BOLD = Enum.Font.GothamBold
local MONO = Enum.Font.RobotoMono

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
	kind: "primary" | "secondary" | "quiet",
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
		else
			button.TextColor3 = palette.text
		end
	end)
	button.MouseLeave:Connect(function()
		if kind == "primary" then
			button.BackgroundColor3 = palette.accent
		elseif kind == "secondary" then
			button.BackgroundColor3 = palette.button
		else
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
	header.Size = UDim2.new(1, 0, 0, 46)
	header.Parent = parent

	local mark = Instance.new("Frame")
	mark.Name = "TraceMark"
	mark.BackgroundColor3 = palette.accent:Lerp(palette.main, 0.86)
	mark.Position = UDim2.fromOffset(0, 3)
	mark.Size = UDim2.fromOffset(34, 34)
	addCorner(mark, 8)
	addStroke(mark, palette.accent:Lerp(palette.main, 0.55))
	mark.Parent = header

	if logoImage ~= "" then
		local logo = Instance.new("ImageLabel")
		logo.Name = "Logo"
		logo.BackgroundTransparency = 1
		logo.Image = logoImage
		logo.ImageColor3 = palette.accent
		logo.Position = UDim2.fromOffset(6, 5)
		logo.Size = UDim2.new(1, -12, 1, -10)
		logo.ScaleType = Enum.ScaleType.Fit
		logo.Parent = mark
	else
		local markText = Instance.new("TextLabel")
		markText.BackgroundTransparency = 1
		markText.Font = FONT_BOLD
		markText.Size = UDim2.fromScale(1, 1)
		markText.Text = "t"
		markText.TextColor3 = palette.accent
		markText.TextSize = 20
		markText.Parent = mark
	end

	local brand = Instance.new("TextLabel")
	brand.BackgroundTransparency = 1
	brand.Font = FONT_BOLD
	brand.Position = UDim2.fromOffset(45, 0)
	brand.Size = UDim2.new(1, -45, 0, 24)
	brand.Text = "trace"
	brand.TextColor3 = palette.text
	brand.TextSize = 17
	brand.TextXAlignment = Enum.TextXAlignment.Left
	brand.Parent = header

	local product = Instance.new("TextLabel")
	product.BackgroundTransparency = 1
	product.Font = FONT_MEDIUM
	product.Position = UDim2.fromOffset(45, 23)
	product.Size = UDim2.new(1, -45, 0, 16)
	product.Text = "Autofix for Studio"
	product.TextColor3 = palette.accent
	product.TextSize = 10
	product.TextXAlignment = Enum.TextXAlignment.Left
	product.Parent = header
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
	label.TextSize = 11
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

local function createMessage(parent: Instance, palette: Palette, text: string, tone: "error" | "success", order: number)
	local message = Instance.new("TextLabel")
	message.Name = "Message"
	message.AutomaticSize = Enum.AutomaticSize.Y
	message.BackgroundColor3 = if tone == "error"
		then palette.error:Lerp(palette.main, 0.82)
		else palette.success:Lerp(palette.main, 0.84)
	message.Font = FONT
	message.LayoutOrder = order
	message.Size = UDim2.new(1, 0, 0, 0)
	message.Text = (if tone == "error" then "  !  " else "  ✓  ") .. text .. "  "
	message.TextColor3 = if tone == "error" then palette.error else palette.success
	message.TextSize = 11
	message.TextWrapped = true
	message.TextXAlignment = Enum.TextXAlignment.Left
	addCorner(message, 6)
	addStroke(
		message,
		if tone == "error" then palette.error:Lerp(palette.main, 0.55) else palette.success:Lerp(palette.main, 0.55)
	)

	local padding = Instance.new("UIPadding")
	padding.PaddingBottom = UDim.new(0, 9)
	padding.PaddingTop = UDim.new(0, 9)
	padding.Parent = message
	message.Parent = parent
end

function Widget.new(plugin: Plugin, callbacks: Callbacks, logoImage: string)
	local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 350, 390, 300, 320)
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
		"Trace will verify your Roblox account and this experience in the browser.",
		10,
		palette.muted,
		FONT,
		60
	)
end

function Widget:_renderLoading(palette: Palette)
	createLabel(self.content, "Connecting", 18, palette.text, FONT_MEDIUM, 10)
	local status = Instance.new("Frame")
	status.BackgroundColor3 = palette.raised
	status.LayoutOrder = 20
	status.Size = UDim2.new(1, 0, 0, 66)
	addCorner(status, 7)
	addStroke(status, palette.border)
	status.Parent = self.content

	local dot = Instance.new("Frame")
	dot.BackgroundColor3 = palette.accent
	dot.Position = UDim2.fromOffset(14, 27)
	dot.Size = UDim2.fromOffset(9, 9)
	addCorner(dot, 5)
	dot.Parent = status

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.Font = FONT
	label.Position = UDim2.fromOffset(34, 13)
	label.Size = UDim2.new(1, -48, 0, 40)
	label.Text = self.state.loadingMessage or "Contacting Trace…"
	label.TextColor3 = palette.muted
	label.TextSize = 12
	label.TextWrapped = true
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.Parent = status
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

	local linkPadding = Instance.new("UIPadding")
	linkPadding.PaddingLeft = UDim.new(0, 10)
	linkPadding.PaddingRight = UDim.new(0, 10)
	linkPadding.Parent = link
	link.Parent = self.content

	link.FocusLost:Connect(function() link.Text = browserUrl end)
	link:GetPropertyChangedSignal("Text"):Connect(function()
		if not link:IsFocused() and link.Text ~= browserUrl then link.Text = browserUrl end
	end)

	local selectLink = createButton(self.content, "Select connection link", "secondary", palette, 40)
	selectLink.MouseButton1Click:Connect(function()
		link:CaptureFocus()
		link.CursorPosition = #browserUrl + 1
		link.SelectionStart = 1
	end)
	createLabel(self.content, "Press ⌘C, then paste the link into Safari or Chrome.", 10, palette.muted, FONT, 45)

	local codeLabel = createLabel(self.content, "TWO-DIGIT CODE", 10, palette.muted, FONT_MEDIUM, 50)
	codeLabel.TextWrapped = false

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

function Widget:_renderConnected(palette: Palette)
	createMessage(self.content, palette, "Connected to " .. (self.state.projectName or "Trace"), "success", 10)
	createLabel(self.content, "Ready for review", 18, palette.text, FONT_MEDIUM, 20)
	createLabel(
		self.content,
		"Trace can now deliver proposed fixes for this game. Publishing stays inside Roblox Studio.",
		12,
		palette.muted,
		FONT,
		30
	)
	createContextCard(self.content, palette, "TRACE SOURCE UNIVERSE", self.state.sourceUniverseId or "—", 40)
	createContextCard(self.content, palette, "STUDIO FIX TARGET", self.state.targetUniverseId or "—", 50)
	local disconnect = createButton(self.content, "Disconnect this Studio", "quiet", palette, 60)
	disconnect.MouseButton1Click:Connect(self.callbacks.onDisconnect)
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
	elseif self.state.kind == "connected" then
		self:_renderConnected(palette)
	end
end

return Widget
