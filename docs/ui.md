# UI Structure

Load this file when changing `public/index.html`, `public/js/app.js`, or UI selectors/IDs.

**Tabs (in `public/index.html`):**

- Dashboard (`#tab-dashboard`)
- Containers (`#tab-containers`)
- Images (`#tab-images`)
- App Creation (`#tab-appcreation`) - primary deployment interface
- Sources/Projects (`#tab-sources`)
- Apps (`#tab-apps`) - deployed apps
- Settings (`#tab-settings`) - includes `#settings-pane-dok` with Default settings, Designer, Groups, and registry connections

**Key UI Elements:**

- Containers: `#containersList`, `#containerSearch`, `#containersOpenApps` (opens the Apps tab), `#refreshContainers`
- Dashboard: `#dashboardTerminalBtn`, `#dashboardCoreLinks`, `#dashboardCoreRefresh`
- Terminal Modal: `#terminalModal`, `#terminalContainer`, `#terminalStopBtn`, `#terminalStatus`, `#terminalSessionLabel`
- OpenCode Card: `#coreOpencodeCard`, `#opencodeStatus`, `#opencodeSessions`, `#opencodeStopBtn`, `#opencodeModel`, `#opencodeProvider`, `#opencodeApiKey`, `#opencodeSaveSettings`
- App Creation: `#runCreateBtn`, `#composeCreateBtn`, `#gitCloneBtn`, `#uploadBtn`, OC Assist (`#assistPrompt`, `#assistData`, `#assistName`, `#assistFiles`, `#assistFolder`, `#assistStartBtn`, `#assistOutput`, `#assistSessions`, `#assistSessionsList`)
- App Config Modal: `#appConfigModal`, `#appCfgBuilder`, `#appCfgCompose`, `#appCfgEditCompose`, `#appCfgValidate`, `#appCfgReferenceUrl`, `#appCfgReferenceLink`, `#appCfgComplete`, `#appCfgCompleteRun`, `#appCfgProgress`
- Notices: `#appCfgNetworkNotice`, `#appCfgVolumeNotice`, `#appCreationNginxNotice`, `#appCreationNginxNoticeModal`
- Modals: `#composeEditWarningModal`, `#composeSaveConfirmModal`, `#appOverwriteModal`, `#amendApprovalModal`, `#libraryExportModal`, `#manualModal`, `#authContainersModal`, `#autheliaUsersModal`, `#designerModal`
- Apps List: `#appsList`, `#appsRefresh`, `#libraryExportBtn`, `#libraryImportFile`, `#libraryExportList`, `#libraryExportDo`
- Manual: `#openManualBtn`, `[data-open-manual]`, `#manualTitle`, `#manualContent`, `#manualNav`
- Settings: `#tab-settings`, `#settingsSubtabs`, `#settings-pane-core`, `#settings-pane-dok`, `#settings-pane-logs`, `#settings-pane-backups`, `#coreAllStart`, `#coreAllStop`, `#coreAllRestart`, `#nginxNetwork`, `#runNginxProxyCore`, `#authRunBtn`, `#dnsRunBtn`, `#mailSmtpHost`, `#mailSmtpPort`, `#mailSmtpTls`, `#mailSmtpUser`, `#mailSmtpPassword`, `#mailSmtpSender`, `#mailSaveSmtp`, `#mailUseMailpit`, `#mailStatus`, `#mailpitRunBtn`, `#mailpitStatus`, `#mailpitOpenBtn`, `#helperRunBtn`
- Designer: `#openDesigner`, `#designerName`, `#designerTagline`, `#designerCss`, `#designerLogoFile`, `#designerLogoUpload`, `#designerLogoRemove`, `#designerFilePath`, `#designerFileContent`, `#designerFileSave`
- Auth picker: `#authContainersList`, `#authApplySelected`, `#authSelectAll`, `#authSelectNone`, `#authApplyMsg`
- Dok Settings: `#defaultsCard`, `#defaultsPrimaryDomain`, `#defaultsDokDomain`, `#defaultsDataLocation`, `#defaultsDataMode`, `#defaultsAllowOutsideData`, `#defaultsAutoAppData`, `#defaultsAdminUser`, `#defaultsAdminEmail`, `#defaultsAdminPassword`, `#defaultsClearAdminPassword`, `#defaultsNetwork`, `#defaultsProtectDok`, `#saveDefaults`, `#defaultsApplyData`, `#defaultsRefresh`, `#groupName`, `#groupContainers`, `#saveGroup`, `#groupsList`, `#registryKind`, `#registryProvider`, `#registryName`, `#registryHost`, `#registryUsername`, `#registrySecret`, `#saveRegistry`, `#cancelRegistryEdit`, `#registriesRefresh`, `#registriesList`
- Authelia management: `#autheliaManageBtn`, `#autheliaOpenBtn`, `#autheliaProtectDok`, `#autheliaPickContainers`, `#autheliaUsersModal`, `#autheliaAdminUser`, `#autheliaAdminEmail`, `#autheliaAdminPassword`, `#autheliaAdminSave`, `#autheliaUserName`, `#autheliaUserDisplay`, `#autheliaUserEmail`, `#autheliaUserPassword`, `#autheliaUserDisabled`, `#autheliaUserSave`, `#autheliaUserCancel`, `#autheliaUsersList`, `#autheliaUsersRefresh`
- Logs: `#serverLogsOutput`, `#serverLogsRefresh`, `#serverLogsClear`, `#appLogsSelect`, `#appLogsRefresh`, `#appLogsOutput`
- Backups: `#createBackupBtn`, `#backupScope`, `#backupCustomOptions`, `#backupAppsSelect`, `#backupCoreSelect`, `#backupsList`, `#backupRefresh`, `#importBackupFile`, `#importBackupBtn`
