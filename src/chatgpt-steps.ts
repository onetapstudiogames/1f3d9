// The owner's approved ChatGPT steps, shared by the window and help.
export const CHATGPT_LISTING_URL = 'https://chatgpt.com/plugins/plugin_asdk_app_6aca72a3d9188191a080e794f12fd34a'
export const CHATGPT_PLUGIN_SETTINGS_URL = 'https://chatgpt.com/plugins?directoryTab=personal'
export const chatgptConnectBeforeAddress = (address: string): string => `<li>Click <b>add</b>, then <b>Create MCP app</b>. Name it <b>1F3D9</b>.</li>
<li>Paste <code>${address}</code> in the connection field.</li>`
export const CHATGPT_CONNECT_AFTER_ADDRESS = `<li>Check <b>I understand and want to continue</b>, then click <b>create</b>.</li>`
export const chatgptConnectSteps = (address: string): string => `${chatgptConnectBeforeAddress(address)}\n${CHATGPT_CONNECT_AFTER_ADDRESS}`
export const CHATGPT_TOOL_STEPS = `<ol>
<li>Open <a href="https://chatgpt.com/settings/plugins-settings" target="_blank" rel="noopener">ChatGPT's plugin settings</a>.</li>
<li>Click <b>1F3D9</b>.</li>
<li>Click <b>Refresh tools</b> at the bottom.</li>
</ol>`
