(memsys) PS D:\SC_project\SocialClaw> D:\conda_envs\emos2\python.exe scripts_3\vlm_test.py
Test image: D:\SC_project\SocialClaw\social_copilot\cache\monitor_frames_20260407_145407\_pending\f_000148_20260407T065634170846Z.png  (345 KB)
Fetching model list...
  Found 22 models.

Testing 22 models...

[1/22] claude-opus-4-6-thinking ... ERR  parse_ok=False  reasoning_tokens=None  60113ms  [The read operation timed out]
[2/22] gpt-5.4-medium ... ERR  parse_ok=False  reasoning_tokens=None  60110ms  [The read operation timed out]
[3/22] gpt-5.4 ... EMPTY  parse_ok=False  reasoning_tokens=320  28042ms
[4/22] claude-sonnet-4-5-20250929 ... ERR  parse_ok=False  reasoning_tokens=None  61236ms  [The read operation timed out]
[5/22] gpt-5.3-codex ... EMPTY  parse_ok=False  reasoning_tokens=461  28374ms
[6/22] claude-sonnet-4-20250514 ... ERR  parse_ok=False  reasoning_tokens=None  60115ms  [The read operation timed out]
[7/22] gpt-5.1 ... EMPTY  parse_ok=False  reasoning_tokens=788  16226ms
[8/22] claude-opus-4-6-20260205 ... ERR  parse_ok=False  reasoning_tokens=None  60130ms  [The read operation timed out]
[9/22] claude-haiku-4-5-20251001 ... OK  parse_ok=True  reasoning_tokens=0  39049ms
[10/22] claude-sonnet-4-5-20250929-thinking ... ERR  parse_ok=False  reasoning_tokens=None  41644ms  [HTTP 400: {"error":{"message":"端点/claude-aws未开启模型claude-sonn]
[11/22] gpt-5.4-xhigh ... OK  parse_ok=True  reasoning_tokens=0  25584ms
[12/22] gpt-5.2-codex ... EMPTY  parse_ok=False  reasoning_tokens=256  25843ms
[13/22] gpt-5.4-high ... OK  parse_ok=True  reasoning_tokens=0  30204ms
[14/22] claude-sonnet-4-6 ... OK  parse_ok=True  reasoning_tokens=0  36445ms
[15/22] gpt-5.2 ... EMPTY  parse_ok=False  reasoning_tokens=296  26443ms
[16/22] claude-opus-4-6 ... EMPTY  parse_ok=False  reasoning_tokens=0  44331ms
[17/22] gpt-5.1-codex-mini ... EMPTY  parse_ok=False  reasoning_tokens=1664  23442ms
[18/22] claude-opus-4-5-20251101-thinking ... ERR  parse_ok=False  reasoning_tokens=None  60104ms  [The read operation timed out]
[19/22] gpt-5.1-codex-max ... EMPTY  parse_ok=False  reasoning_tokens=640  27908ms
[20/22] claude-sonnet-4-6-thinking ... OK  parse_ok=True  reasoning_tokens=0  9538ms
[21/22] claude-opus-4-5-20251101 ... ERR  parse_ok=False  reasoning_tokens=None  60107ms  [The read operation timed out]
[22/22] gpt-5.1-codex ... EMPTY  parse_ok=False  reasoning_tokens=640  20129ms

==========================================================================================
Model                                    OK    Reason.Tok   ms       Error
------------------------------------------------------------------------------------------
claude-opus-4-6-thinking                 False None         60113    The read operation timed out
gpt-5.4-medium                           False None         60110    The read operation timed out
gpt-5.4                                  False 320          28042
claude-sonnet-4-5-20250929               False None         61236    The read operation timed out
gpt-5.3-codex                            False 461          28374
claude-sonnet-4-20250514                 False None         60115    The read operation timed out
gpt-5.1                                  False 788          16226
claude-opus-4-6-20260205                 False None         60130    The read operation timed out
claude-haiku-4-5-20251001                True  0            39049
claude-sonnet-4-5-20250929-thinking      False None         41644    HTTP 400: {"error":{"message":"端点/claude
gpt-5.4-xhigh                            True  0            25584
gpt-5.2-codex                            False 256          25843
gpt-5.4-high                             True  0            30204
claude-sonnet-4-6                        True  0            36445
gpt-5.2                                  False 296          26443
claude-opus-4-6                          False 0            44331
gpt-5.1-codex-mini                       False 1664         23442
claude-opus-4-5-20251101-thinking        False None         60104    The read operation timed out
gpt-5.1-codex-max                        False 640          27908
claude-sonnet-4-6-thinking               True  0            9538
claude-opus-4-5-20251101                 False None         60107    The read operation timed out
gpt-5.1-codex                            False 640          20129
==========================================================================================
                                                                                                                                                                           Results saved to: D:\SC_project\SocialClaw\logs\vlm_test         