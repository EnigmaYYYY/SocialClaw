"""
LLM Judge evaluator - use LLM to judge answer correctness.

Aligned with evaluation_archive logic:
- Keep independent judgments for each run (judgment_1, judgment_2, judgment_3)
- Calculate accuracy for each run separately
- Output mean and std
"""
import asyncio
import json
import numpy as np
from typing import List, Dict, Any
from collections import defaultdict
from openai import AsyncOpenAI
from tqdm import tqdm

from evaluation.src.evaluators.base import BaseEvaluator
from evaluation.src.evaluators.registry import register_evaluator
from evaluation.src.core.data_models import AnswerResult, EvaluationResult
from evaluation.src.utils.prompts import get_prompt, format_prompt


@register_evaluator("llm_judge")
class LLMJudge(BaseEvaluator):
    """LLM judge evaluator."""
    
    def __init__(self, config: dict):
        super().__init__(config)
        
        # Initialize OpenAI client
        llm_config = config.get("llm", {})
        self.client = AsyncOpenAI(
            api_key=llm_config.get("api_key"),
            base_url=llm_config.get("base_url", "https://api.openai.com/v1")
        )
        self.model = llm_config.get("model", "gpt-4o-mini")
        self.num_runs = config.get("num_runs", 3)
    
    async def evaluate(
        self, 
        answer_results: List[AnswerResult]
    ) -> EvaluationResult:
        """
        Evaluate answers using LLM, return statistics from multiple runs.
        
        Args:
            answer_results: List of answer results
            
        Returns:
            Evaluation result with mean and std
        """
        print(f"\n{'='*60}")
        print(f"Evaluation: LLM Judge (model={self.model}, runs={self.num_runs})")
        print(f"{'='*60}")
        
        detailed_results = []
        
        # Evaluate all answers concurrently
        semaphore = asyncio.Semaphore(10)  # Limit concurrency
        
        # Use tqdm progress bar
        pbar = tqdm(total=len(answer_results), desc="⚖️  Evaluate Progress", unit="qa")
        
        async def evaluate_single(answer_result: AnswerResult):
            async with semaphore:
                result = await self._evaluate_single_answer(answer_result)
                pbar.update(1)  # Update progress bar
                return result
        
        tasks = [evaluate_single(ar) for ar in answer_results]
        results = await asyncio.gather(*tasks)
        
        # Close progress bar
        pbar.close()
        
        # Collect results
        for result in results:
            detailed_results.append(result)
        
        # Calculate accuracy for each run separately
        run_scores = []
        category_stats = defaultdict(lambda: {"correct": [0] * self.num_runs, "total": 0})
        
        for i in range(self.num_runs):
            judgment_key = f"judgment_{i+1}"
            correct_count = 0
            total_count = 0
            
            for result in detailed_results:
                llm_judgments = result.get("llm_judgments", {})
                category = result.get("category")
                
                if judgment_key in llm_judgments:
                    total_count += 1
                    if llm_judgments[judgment_key]:
                        correct_count += 1
                        if category is not None:
                            category_stats[category]["correct"][i] += 1
                
                    # Count category total (only need once)
                if i == 0 and category is not None:
                    category_stats[category]["total"] += 1
            
            if total_count > 0:
                run_accuracy = correct_count / total_count
                run_scores.append(run_accuracy)
        
        # Calculate statistics
        mean_accuracy = np.mean(run_scores) if run_scores else 0.0
        std_accuracy = np.std(run_scores) if run_scores else 0.0
        
        # Calculate accuracy for each category
        category_accuracies = {}
        for category, stats in category_stats.items():
            cat_accuracies = []
            for i in range(self.num_runs):
                if stats["total"] > 0:
                    cat_acc = stats["correct"][i] / stats["total"]
                    cat_accuracies.append(cat_acc)
            
            if cat_accuracies:
                category_accuracies[str(category)] = {
                    "mean": np.mean(cat_accuracies),
                    "std": np.std(cat_accuracies),
                    "individual_runs": cat_accuracies,
                    "total": stats["total"]
                }
        
        print(f"\n✅ Evaluation complete:")
        print(f"   - Total questions: {len(answer_results)}")
        print(f"   - Mean accuracy: {mean_accuracy:.4f} ({mean_accuracy*100:.2f}%)")
        print(f"   - Std deviation: {std_accuracy:.4f}")
        print(f"   - Run accuracies: {[f'{s:.4f}' for s in run_scores]}")
        
        if category_accuracies:
            print(f"\n📊 Category statistics:")
            for cat, stats in sorted(category_accuracies.items()):
                print(f"   Category {cat}: {stats['mean']:.4f} ± {stats['std']:.4f} (n={stats['total']})")
        
        # Group by conversation
        grouped_results = self._group_by_conversation(detailed_results)
        
        return EvaluationResult(
            total_questions=len(answer_results),
            correct=int(mean_accuracy * len(answer_results)),  # Use mean for calculation
            accuracy=mean_accuracy,
            detailed_results=grouped_results,
            metadata={
                "model": self.model,
                "num_runs": self.num_runs,
                "mean_accuracy": mean_accuracy,
                "std_accuracy": std_accuracy,
                "run_scores": run_scores,
                "category_accuracies": category_accuracies
            }
        )
    
    def _group_by_conversation(self, detailed_results: List[Dict]) -> Dict[str, List[Dict]]:
        """
        Group results by conversation (e.g., locomo_exp_user_0, locomo_exp_user_1, etc.).
        """
        grouped = defaultdict(list)
        
        for result in detailed_results:
            question_id = result.get("question_id", "")
            
            # Extract conversation info from question_id
            # Example: "locomo_0_qa0" -> "locomo_exp_user_0"
            # Example: "personamem_5_qa2" -> "personamem_exp_user_5"
            if "_qa" in question_id:
                parts = question_id.split("_qa")
                conv_id = parts[0]  # "locomo_0" or "personamem_5"
                
                # Convert to evaluation_archive format
                if "_" in conv_id:
                    dataset_name, conv_num = conv_id.rsplit("_", 1)
                    group_key = f"{dataset_name}_exp_user_{conv_num}"
                else:
                    group_key = f"{conv_id}_exp_user_0"
            else:
                # Use default group if format doesn't match
                group_key = "default_group"
            
            grouped[group_key].append(result)
        
        return dict(grouped)
    
    async def _evaluate_single_answer(self, answer_result: AnswerResult) -> dict:
        """
        Evaluate single answer, keep independent judgment for each run.
        """
        question = answer_result.question
        golden_answer = answer_result.golden_answer
        generated_answer = answer_result.answer
        
        # Multiple evaluations, keep independent judgments
        judgments = []
        for _ in range(self.num_runs):
            is_correct = await self._judge_answer(
                question, golden_answer, generated_answer
            )
            judgments.append(is_correct)
        
        # Use judgment_1, judgment_2, ... format
        llm_judgments = {
            f"judgment_{i+1}": judgment 
            for i, judgment in enumerate(judgments)
        }
        
        return {
            "question_id": answer_result.question_id,
            "question": question,
            "golden_answer": golden_answer,
            "generated_answer": generated_answer,
            "llm_judgments": llm_judgments,
            "category": answer_result.category,
        }
    
    async def _judge_answer(
        self, 
        question: str, 
        golden_answer: str, 
        generated_answer: str
    ) -> bool:
        """
        Use LLM to judge if answer is correct.
        
        Returns:
            True if correct, False if wrong
        """
        # Use configured prompts
        system_prompt = get_prompt("llm_judge", "system_prompt")
        user_prompt = format_prompt(
            "llm_judge",
            "user_prompt",
            question=question,
            golden_answer=golden_answer,
            generated_answer=generated_answer
        )
        
        try:
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0,
            )
            
            content = response.choices[0].message.content
            result = json.loads(content)
            label = result.get("label", "WRONG")
            
            return label.strip().upper() == "CORRECT"
        
        except Exception as e:
            print(f"  ⚠️ LLM Judge failed: {e}")
            return False

