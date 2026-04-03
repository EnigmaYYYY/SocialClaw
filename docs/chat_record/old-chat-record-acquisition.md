# WeChat Old Chat Record Acquisition Pipeline

## Scope

This document records the only WeChat old-chat export pipeline that is currently validated for SocialClaw.

It is based on the author's published Zhihu guide:

- [微信聊天数据免费导出文件指南](https://zhuanlan.zhihu.com/p/1991993423289413743)

This is not a generic survey of all possible extraction methods. It is a structured write-up of the one workflow that has already been tested end to end.

## Pipeline Summary

The validated pipeline is:

1. install `WeChat 3.9.12` `32-bit` on Windows
2. use the compatibility launcher to make that build log in normally
3. migrate chat history from the phone into the Windows `3.x` client
4. open the migrated data with `MemoTrace 2.1.1`
5. export the specific friend or group chat you need
6. import the exported result into SocialClaw

In short:

```text
Windows WeChat 3.9.12 32-bit
-> compatibility launcher
-> phone-to-PC chat migration
-> MemoTrace 2.1.1
-> per-chat export
-> SocialClaw import
```

## Why This Pipeline Exists

The key idea is practical compatibility.

The current verified route does not start from direct raw-database parsing inside SocialClaw. Instead, it first recreates a desktop WeChat environment that can successfully receive migrated chat history, then uses MemoTrace to read and export that history in a usable form.

That is the pipeline that is known to work right now.

## Prerequisites

- A Windows machine
- A WeChat account with chat history still available on the phone
- WeChat `3.9.12` `32-bit`
- The compatibility launcher from:
  - [Skyler1n/WeChat3.9-32bit-Compatibility-Launcher](https://github.com/Skyler1n/WeChat3.9-32bit-Compatibility-Launcher)
- `MemoTrace 2.1.1`

## Step 1: Install WeChat 3.9.12 32-bit

Install WeChat `3.9.12` `32-bit` on Windows.

Important note from the validated workflow:

- newer mainstream WeChat installs are now centered on `4.x`
- the working export route here depends on the older `3.9.12` `32-bit` line

After installing WeChat, follow the compatibility-launcher repository instructions and place `wechat_starter.exe` into the normal WeChat install directory.

Typical path:

```text
C:\Program Files (x86)\Tencent\WeChat
```

Then run `wechat_starter.exe` and confirm that the `3.9.12` client can log in successfully.

## Step 2: Migrate Chat History From Phone to the 3.x Desktop Client

Once the `3.9.12` client is logged in, migrate chat history from the phone into that desktop instance.

On the phone:

1. open `Settings`
2. open `Chats`
3. open `Chat History Migration & Backup`
4. choose `Migrate to Computer`

Then:

1. let the desktop `3.x` WeChat client connect by scanning the QR code
2. choose the chats you want to migrate
3. you may select:
   - a single friend
   - a single group
   - or all chats if needed
4. wait until migration is fully complete

Do not move on until the `3.x` Windows WeChat client can visibly display the migrated conversation history.

## Step 3: Install and Open MemoTrace 2.1.1

After migration is finished, install and run `MemoTrace 2.1.1`.

The validated guide explicitly uses version `2.1.1`.

The practical rule is:

- finish the migration first
- then start MemoTrace
- let MemoTrace read the migrated WeChat records

Once MemoTrace opens the data successfully, you should be able to browse the imported chat history inside the tool.

## Step 4: Export the Target Chat

After the previous steps succeed, use MemoTrace to search for the friend or group chat you want to export.

Then export that chat in the format you need.

Observed limitation from the verified workflow:

- this route appears to support exporting specific friends or groups
- it does **not** appear to support one-click export for every contact and every group in a single batch

So the expected usage is selective export, not global bulk export.

## Expected Export Artifacts

In practice, the exported output can include artifacts such as:

- `.csv`
- `.html`
- media subfolders such as avatars, emoji, images, or files

A typical conversation export folder may look like this:

```text
21-新传-宋悦(wxid_h6cbjnu4re9722)/
├── 21-新传-宋悦.csv
├── 21-新传-宋悦.html
├── avatar/
├── emoji/
├── image/
└── file/
```

One currently supported CSV header shape in this repository is:

```csv
localId,TalkerId,Type,SubType,IsSender,CreateTime,Status,StrContent,StrTime,Remark,NickName,Sender
```

## Importing the Export Into SocialClaw

After exporting the target chat:

1. open SocialClaw
2. go to the onboarding import flow or the profile-library import area
3. choose the exported file or folder
4. import the CSV or the full export folder
5. let SocialClaw normalize the imported chat history
6. run old-chat backfill if you want to rebuild profiles from imported records

SocialClaw already recognizes practical import inputs such as:

- supported CSV exports
- export folders produced from this workflow

## Operational Notes

- This document describes the pipeline that is currently proven, not all theoretically possible pipelines.
- The most fragile part is compatibility setup for the old Windows WeChat build.
- The migration step is mandatory in this workflow because MemoTrace needs the chat data to already exist in the desktop client.
- If migration is incomplete, MemoTrace will not see the history you expect.

## Limitations

- Currently validated on the Windows-side legacy client workflow, not documented here as a macOS-native verified export path.
- Export is chat-by-chat in practical use.
- Tool versions matter here; changing them may break reproducibility.

## References

- [Zhihu guide: 微信聊天数据免费导出文件指南](https://zhuanlan.zhihu.com/p/1991993423289413743)
- [Compatibility launcher: Skyler1n/WeChat3.9-32bit-Compatibility-Launcher](https://github.com/Skyler1n/WeChat3.9-32bit-Compatibility-Launcher)

## Bottom Line

If you need the currently working old-chat acquisition method for SocialClaw, use this exact sequence:

`WeChat 3.9.12 32-bit -> compatibility launcher -> migrate chats from phone to desktop -> MemoTrace 2.1.1 -> export the target chat -> import into SocialClaw`
