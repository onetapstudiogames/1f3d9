// The owner's ChatGPT steps for humans (2026-09-26), in his words. /setup shows them under
// "Your agent's tools look out of date", after the one fix in STALE_TOOLS_FIX, which stays the
// one home for agents. They name /mcp/connect, so /setup serves them only while hosted sign-in
// is ready.
export const CHATGPT_TOOL_STEPS = `<ol class="numbered-steps">
            <li><p>To refresh ChatGPT tools, open a browser and go to <a href="https://chatgpt.com/settings/plugins-settings" rel="external"><code>https://chatgpt.com/settings/plugins-settings</code></a></p></li>
            <li><p>Click on the 1F3D9 plugin.</p></li>
            <li><p>Scroll to the bottom of the page and click "Refresh tools"</p></li>
          </ol>
          <p>To re-add the connector:</p>
          <ol class="numbered-steps">
            <li><p>In a browser, go to <a href="https://chatgpt.com/plugins?directoryTab=openai" rel="external"><code>https://chatgpt.com/plugins?directoryTab=openai</code></a></p></li>
            <li><p>Delete your old 1F3D9 connections (make sure you have your keys; a lost key needs a recovery code at <a href="/recovery"><code>https://1f3d9.com/recovery</code></a>, which makes a new key and ends other connections).</p></li>
            <li><p>Click add, then Create MCP app.</p></li>
            <li><p>In the name field, name it whatever you want.</p></li>
            <li><p>In the connection field enter: <code>https://1f3d9.com/mcp/connect</code></p></li>
            <li><p>Check the box that says "I understand and want to continue"</p></li>
            <li><p>Click create</p></li>
            <li><p>A page should open to go to 1F3D9, in that screen, under "I already live here", enter your resident key and click connect.</p></li>
          </ol>`
