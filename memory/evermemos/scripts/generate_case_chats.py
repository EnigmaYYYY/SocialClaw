import json
from datetime import datetime, timedelta
from pathlib import Path

OUT_DIR = Path("my_chat/cases")
OUT_DIR.mkdir(parents=True, exist_ok=True)

OWNER_ID = "wxid_fcekh048yglj22"
OWNER_NAME = "李星"


def pick(arr, i):
    return arr[i % len(arr)]


def build_meta(group_id, name, desc, other_id, other_name):
    return {
        "version": "1.0.0",
        "conversation_meta": {
            "scene": "private",
            "scene_desc": {
                "owner_user_name": OWNER_NAME,
                "owner_user_id": OWNER_ID,
            },
            "name": name,
            "description": desc,
            "group_id": group_id,
            "created_at": "2024-03-01T08:00:00+00:00",
            "default_timezone": "UTC",
            "user_details": {
                OWNER_ID: {"full_name": OWNER_NAME, "role": "user"},
                other_id: {"full_name": other_name, "role": "user"},
            },
            "tags": ["synthetic", "persona-consistent"],
        },
    }


def build_rows(messages, start_id=100000, start_time="2024-03-01T08:00:00+00:00"):
    dt = datetime.fromisoformat(start_time)
    rows = []
    for i, (sender, sender_name, content) in enumerate(messages):
        rows.append(
            {
                "message_id": str(start_id + i),
                "create_time": (dt + timedelta(minutes=2 * i)).isoformat(),
                "sender": sender,
                "sender_name": sender_name,
                "type": "text",
                "content": content,
                "refer_list": [],
            }
        )
    return rows


def write_pair(prefix, group_id, other_id, other_name, full_messages, start_id):
    assert len(full_messages) == 130
    mem = build_meta(
        group_id,
        f"Chat with {other_name} - {prefix}",
        f"{prefix} memory extraction dataset (100 messages)",
        other_id,
        other_name,
    )
    mem["conversation_list"] = build_rows(full_messages[:100], start_id=start_id)

    test = build_meta(
        group_id,
        f"Chat with {other_name} - {prefix}",
        f"{prefix} testing dataset (30 messages continuation)",
        other_id,
        other_name,
    )
    test["conversation_list"] = build_rows(full_messages[100:], start_id=start_id + 100)

    (OUT_DIR / f"{prefix}_mem_100.json").write_text(
        json.dumps(mem, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (OUT_DIR / f"{prefix}_test_30.json").write_text(
        json.dumps(test, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def build_mentor_msgs():
    mentor_id = "wxid_mentor_wang001"
    mentor_name = "王工"

    items = [
        ("留存看板", "17:40", "新用户口径", "明早站会讲稿"),
        ("用户分层SQL", "18:00", "分层阈值", "字段注释"),
        ("转化漏斗复盘", "18:15", "断点原因", "评审会备注"),
        ("渠道日报", "18:20", "异常波动", "图例命名"),
        ("新手引导埋点", "18:05", "漏采事件", "埋点对照表"),
        ("活动复盘PPT", "17:50", "样本偏差", "一页摘要"),
        ("退款原因标签", "18:10", "高频标签解释", "标签字典"),
        ("客服满意度表", "18:25", "低分原因", "异常样本截图"),
        ("实验组样本核对", "18:00", "重复样本", "核对记录"),
        ("周报结论页", "17:55", "可执行动作", "总监邮件摘要"),
        ("次日留存口径", "18:20", "口径差异", "口径说明附件"),
        ("投放成本拆分", "18:30", "归因逻辑", "预算口径备注"),
        ("月度复盘草稿", "18:10", "结论可信度", "目录结构"),
    ]

    mentor_tone = [
        "我先要能汇报的版本，别等完美。",
        "这版重时效，不重花活。",
        "先把风险讲明白，业务侧最关心这个。",
        "你先给我可决策信息，细节后补。",
    ]
    user_tone = [
        "收到，我先交可用版。",
        "明白，我不憋终稿了。",
        "行，我先把关键问题顶出来。",
        "好，我先保证可汇报。",
    ]
    coach_tone = [
        "你反应快是优势，再把节奏稳住。",
        "你课程和实习并行，提前量要再多一点。",
        "你情绪上来时语速会快，汇报记得放慢。",
        "这周进步明显，继续这个节奏。",
    ]

    messages = []
    for i, (task, eta, risk, side) in enumerate(items):
        messages.extend(
            [
                (mentor_id, mentor_name, f"李星，{task}今天{eta}前给我一个可汇报版本。"),
                (OWNER_ID, OWNER_NAME, f"在做了，我下午没课，{eta}前先发你初版。"),
                (mentor_id, mentor_name, f"重点盯{risk}，不要只给均值。"),
                (OWNER_ID, OWNER_NAME, f"明白，我把{risk}放第一页，后面再补过程。"),
                (mentor_id, mentor_name, f"另外{side}也顺手处理掉，避免会里被追问。"),
                (OWNER_ID, OWNER_NAME, f"好，我做完{task}就接着处理{side}。"),
                (mentor_id, mentor_name, f"{pick(mentor_tone, i)} 这轮就按{task}这个优先级来。"),
                (OWNER_ID, OWNER_NAME, f"{pick(user_tone, i)} {task}我先顶住。"),
                (mentor_id, mentor_name, f"{pick(coach_tone, i)} 你做{task}时尤其注意。"),
                (OWNER_ID, OWNER_NAME, f"收到王工，我22岁第一次长线实习，会把节奏再往前提。"),
            ]
        )
    return mentor_id, mentor_name, messages


def build_advisor_msgs():
    advisor_id = "wxid_teacher_chen001"
    advisor_name = "陈老师"

    items = [
        ("开题报告", "研究问题", "周四晚"),
        ("文献综述", "核心争议点", "周五中午"),
        ("实验设计", "变量定义", "周四晚"),
        ("访谈提纲", "问题梯度", "周五下午"),
        ("问卷清洗", "异常值处理", "周四晚"),
        ("模型对比", "评价指标", "周五中午"),
        ("中期答辩", "叙事主线", "周四晚"),
        ("论文框架", "章节逻辑", "周五下午"),
        ("实验复现", "步骤可复核", "周四晚"),
        ("结果讨论", "解释边界", "周五中午"),
        ("伦理申请", "风险说明", "周四晚"),
        ("附录整理", "数据来源", "周五下午"),
        ("终稿排版", "格式统一", "周四晚"),
    ]

    teacher_lines = [
        "先给我可评审版，不要攒终版。",
        "口语化表达再收一收，保持学术语气。",
        "你想法不少，先守住证据链。",
        "宁可短一点，也要逻辑闭环。",
    ]
    user_lines = [
        "好的老师，我先交可审阅版本。",
        "收到，我会先把主线收敛。",
        "明白，我先啃最难那段，不再拖。",
        "好，我先关社媒两小时专注写。",
    ]

    messages = []
    for i, (topic, focus, ddl) in enumerate(items):
        messages.extend(
            [
                (advisor_id, advisor_name, f"李星，{topic}这周推进到哪一步了？"),
                (OWNER_ID, OWNER_NAME, f"老师，我昨晚写到一点，{topic}主体有了，但{focus}还在打磨。"),
                (advisor_id, advisor_name, f"这版先把{focus}写硬一点。"),
                (OWNER_ID, OWNER_NAME, f"收到，我今天先把{focus}补扎实。"),
                (advisor_id, advisor_name, f"{pick(teacher_lines, i)} 先把{topic}这一节立住。"),
                (OWNER_ID, OWNER_NAME, f"{pick(user_lines, i)} 我先把{topic}按主线重排。"),
                (advisor_id, advisor_name, f"你情绪表达外露是优点，但讲{topic}时语速要稳。"),
                (OWNER_ID, OWNER_NAME, f"明白，我讲{topic}会更克制，先结论后细节。"),
                (advisor_id, advisor_name, f"{ddl}前发我邮箱，我按这一版给你批注。"),
                (OWNER_ID, OWNER_NAME, f"好的老师，我{ddl}前发您，不再临门赶工。"),
            ]
        )
    return advisor_id, advisor_name, messages


def build_parent_msgs():
    parent_id = "wxid_mom_li001"
    parent_name = "妈妈"

    items = [
        ("作息", "别熬太晚", "今晚十二点前睡"),
        ("饮食", "三餐别乱", "先去食堂吃饭"),
        ("开销", "按月记账", "咖啡预算压下来"),
        ("复试", "把目标拆小", "先做两小时真题"),
        ("租房", "条款看细", "周末线下再看一套"),
        ("回家时间", "路上注意安全", "这周末打视频"),
        ("运动", "每周动两次", "周六去打羽毛球"),
        ("体检", "预约别拖", "下周一先挂号"),
        ("奖学金", "材料提前备", "今晚先列清单"),
        ("实习", "别受委屈不说", "有事先和你们讲"),
        ("情绪", "难受就讲出来", "先去操场走一圈"),
        ("同学相处", "边界感要有", "不再什么都答应"),
        ("未来计划", "先想清再发力", "先定三个月目标"),
    ]

    mom_values = [
        "家里不求你一下子多厉害，稳住就好。",
        "身体是本钱，成绩只是阶段结果。",
        "别跟别人比节奏，按你自己的步子来。",
        "遇到事先说，家里永远在你这边。",
    ]

    messages = []
    for i, (topic, remind, action) in enumerate(items):
        messages.extend(
            [
                (parent_id, parent_name, f"小星，最近{topic}怎么样？我和你爸有点惦记。"),
                (OWNER_ID, OWNER_NAME, f"还行啦妈，这周课和实习叠一起，我在调{topic}节奏。"),
                (parent_id, parent_name, f"你都22了，{remind}。"),
                (OWNER_ID, OWNER_NAME, f"知道啦，我今天就{action}。"),
                (parent_id, parent_name, pick(mom_values, i)),
                (OWNER_ID, OWNER_NAME, f"嗯嗯，我也想走长期稳定路线，先把{topic}稳住。"),
                (parent_id, parent_name, f"你最近拍照还在拍吗？别因为{topic}把爱好全停了。"),
                (OWNER_ID, OWNER_NAME, f"在拍，我周末会去江边拍落日，顺便把{topic}压力放一放。"),
                (parent_id, parent_name, f"行，忙完{topic}给家里回个消息就行。"),
                (OWNER_ID, OWNER_NAME, f"好嘞妈，爱你，我先去把{topic}这段收一下。"),
            ]
        )
    return parent_id, parent_name, messages


def build_friend_msgs():
    friend_id = "wxid_friend_lin001"
    friend_name = "林悦"

    items = [
        ("复试", "晚饭后图书馆一小时", "英语口语"),
        ("实验课", "买热饮走一圈", "实验记录"),
        ("兼职", "操场慢走二十分钟", "时间块"),
        ("追剧", "你宿舍楼下聊十分钟", "先写后看"),
        ("羽毛球", "打半小时球", "周计划"),
        ("拍照", "周末去江边拍夜景", "情绪释放"),
        ("周末出行", "看个小展", "预算"),
        ("宿舍卫生", "先分工再开干", "执行顺序"),
        ("论文进度", "番茄钟两轮", "核心段落"),
        ("情绪波动", "去便利店买点吃的", "状态恢复"),
        ("社团活动", "先筛优先级", "拒绝无效会"),
        ("考证", "错题本先过一遍", "每天40分钟"),
        ("找工作", "更新一版简历", "投递节奏"),
    ]

    friend_tease = [
        "你一急就语速飞起，先喝口水。",
        "你对熟人太松弛，老爱把活全揽了。",
        "你就是嘴硬心软，典型李星模式。",
        "先别自责，先把顺序排好。",
    ]

    messages = []
    for i, (topic, hangout, fix) in enumerate(items):
        messages.extend(
            [
                (friend_id, friend_name, f"星宝，你这阵子{topic}咋样？"),
                (OWNER_ID, OWNER_NAME, f"别提了，我昨天又拖到一点，{topic}才收尾[捂脸]。"),
                (friend_id, friend_name, pick(friend_tease, i)),
                (OWNER_ID, OWNER_NAME, f"被你说中，我在{topic}上确实容易上头。"),
                (friend_id, friend_name, f"要不今晚{hangout}，顺便把{fix}聊顺？"),
                (OWNER_ID, OWNER_NAME, f"行，我先把{topic}这页存一下，十分钟后到。"),
                (friend_id, friend_name, f"你不是一直说想稳一点嘛，今天先把{fix}稳住。"),
                (OWNER_ID, OWNER_NAME, f"嗯，我先把{fix}定住，不再乱接新任务。"),
                (friend_id, friend_name, f"周末我们再安排个轻松局，别让{topic}占满你。"),
                (OWNER_ID, OWNER_NAME, f"好，和{topic}错开来，拍照/打球/看展都行。"),
            ]
        )
    return friend_id, friend_name, messages


def build_lover_msgs():
    lover_id = "wxid_lover_zhou001"
    lover_name = "周远"

    items = [
        ("见面频率", "周末见一面", "不临时爽约"),
        ("异地通勤", "提前订票", "别临走前手忙脚乱"),
        ("复习压力", "先报状态再聊细节", "不闷着"),
        ("实习冲突", "把时间表对齐", "减少误会"),
        ("安全感", "低落就发一个‘在’", "给彼此信号"),
        ("未来规划", "按季度聊一次", "不凭情绪决策"),
        ("吵架修复", "先暂停十分钟", "再讲事实"),
        ("纪念日", "提前一周确认", "别等最后一天"),
        ("消费观", "大额先商量", "小额各自自由"),
        ("作息", "互相提醒别熬夜", "先把身体稳住"),
        ("家庭观念", "慢慢磨合", "不急着下结论"),
        ("工作选择", "看长期成长", "不只看短期薪资"),
        ("节假日安排", "先排优先级", "双方都留空间"),
    ]

    lover_msgs = []
    for i, (topic, rule, target) in enumerate(items):
        lover_msgs.extend(
            [
                (lover_id, lover_name, f"今天想聊聊我们最近的{topic}。"),
                (OWNER_ID, OWNER_NAME, f"好呀，我刚忙完，脑子有点乱，但{topic}这块可以好好聊。"),
                (lover_id, lover_name, f"你最近一遇到{topic}压力就会突然安静，我会担心。"),
                (OWNER_ID, OWNER_NAME, f"嗯，我有时候会先自己消化，尤其是{topic}卡住的时候。"),
                (lover_id, lover_name, f"那我们试试这个规则：{rule}。"),
                (OWNER_ID, OWNER_NAME, f"可以，这样我比较容易执行，也更接近{target}。"),
                (lover_id, lover_name, f"我想要的是我们在{topic}上一起成长，不是只说好听话。"),
                (OWNER_ID, OWNER_NAME, f"我也是，我想要长期稳定，不想在{topic}上消耗彼此。"),
                (lover_id, lover_name, f"那就慢一点，但方向一致，{topic}有分歧就当面讲。"),
                (OWNER_ID, OWNER_NAME, f"好，今天关于{topic}这个结论我记住了，我们按这个往前走。"),
            ]
        )
    return lover_id, lover_name, lover_msgs


def main():
    mentor_id, mentor_name, mentor_msgs = build_mentor_msgs()
    advisor_id, advisor_name, advisor_msgs = build_advisor_msgs()
    parent_id, parent_name, parent_msgs = build_parent_msgs()
    friend_id, friend_name, friend_msgs = build_friend_msgs()
    lover_id, lover_name, lover_msgs = build_lover_msgs()

    for arr in [mentor_msgs, advisor_msgs, parent_msgs, friend_msgs, lover_msgs]:
        assert len(arr) == 130

    write_pair("mentor", "chat_wxid_fcekh048yglj22_wxid_mentor_wang001_mentor", mentor_id, mentor_name, mentor_msgs, 100000)
    write_pair("advisor", "chat_wxid_fcekh048yglj22_wxid_teacher_chen001_advisor", advisor_id, advisor_name, advisor_msgs, 200000)
    write_pair("parent", "chat_wxid_fcekh048yglj22_wxid_mom_li001_parent", parent_id, parent_name, parent_msgs, 300000)
    write_pair("friend", "chat_wxid_fcekh048yglj22_wxid_friend_lin001_friend", friend_id, friend_name, friend_msgs, 400000)
    write_pair("lover", "chat_wxid_fcekh048yglj22_wxid_lover_zhou001_lover", lover_id, lover_name, lover_msgs, 500000)

    print("generated")


if __name__ == "__main__":
    main()
