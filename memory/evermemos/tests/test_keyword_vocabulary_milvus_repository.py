#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test the functionality of KeywordVocabularyMilvusRepository

Test contents include:
1. Basic CRUD operations (create, read, update, delete)
2. Vector similarity search
3. Type-based filtering search
4. Batch operations
5. Edge case testing
"""

import asyncio
from typing import List
import numpy as np
from core.di import get_bean_by_type
from infra_layer.adapters.out.search.repository.keyword_vocabulary_milvus_repository import (
    KeywordVocabularyMilvusRepository,
)
from core.observation.logger import get_logger

logger = get_logger(__name__)


def generate_random_vector(dim: int = 1024) -> List[float]:
    """Generate random vector for testing"""
    return np.random.randn(dim).astype(np.float32).tolist()


def generate_similar_vector(
    base_vector: List[float], noise_level: float = 0.1
) -> List[float]:
    """Generate a vector similar to the base vector"""
    noise = np.random.normal(0, noise_level, len(base_vector))
    return [float(x + n) for x, n in zip(base_vector, noise)]


async def test_basic_crud_operations():
    """Test basic CRUD operations"""
    logger.info("========== Starting basic CRUD operations test ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    test_keyword = "machine learning"
    test_type = "technology"
    test_vector = generate_random_vector()
    test_model = "bge-m3"

    try:
        # Test 1: Create keyword (Create)
        logger.info("Test 1: Create keyword")
        doc = await repo.create_and_save_keyword(
            keyword=test_keyword,
            keyword_type=test_type,
            vector=test_vector,
            vector_model=test_model,
        )

        assert doc is not None
        assert doc["keyword"] == test_keyword
        assert doc["type"] == test_type
        assert doc["vector_model"] == test_model
        logger.info("✅ Keyword created successfully: %s", test_keyword)

        # Wait for data refresh
        await repo.flush()
        await asyncio.sleep(1)

        # Test 2: Exact query by text (Read)
        logger.info("Test 2: Exact query by text")
        retrieved_doc = await repo.get_keyword_by_text(
            keyword=test_keyword, keyword_type=test_type
        )

        assert retrieved_doc is not None
        assert retrieved_doc["keyword"] == test_keyword
        assert retrieved_doc["type"] == test_type
        assert retrieved_doc["vector_model"] == test_model
        logger.info("✅ Exact query successful: %s", test_keyword)

        # Test 3: Delete by ID (Delete)
        logger.info("Test 3: Delete by ID")
        keyword_id = retrieved_doc["id"]
        delete_result = await repo.delete_by_keyword_id(keyword_id)
        assert delete_result is True
        logger.info("✅ Keyword deleted successfully: id=%s", keyword_id)

        # Verify deletion
        await repo.flush()
        await asyncio.sleep(1)
        deleted_check = await repo.get_keyword_by_text(test_keyword, test_type)
        assert deleted_check is None, "Keyword should have been deleted"
        logger.info("✅ Deletion verified")

    except Exception as e:
        logger.error("❌ Basic CRUD operations test failed: %s", e)
        # Clean up any residual data
        try:
            await repo.delete_by_keyword_text(test_keyword, test_type)
            await repo.flush()
        except Exception:
            pass
        raise

    logger.info("✅ Basic CRUD operations test completed\n")


async def test_vector_similarity_search():
    """Test vector similarity search"""
    logger.info("========== Starting vector similarity search test ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    test_type = "ai_concept"
    base_vector = generate_random_vector()
    test_model = "bge-m3"

    # Prepare test data
    test_keywords = [
        {"keyword": "deep learning", "similarity": "high"},
        {"keyword": "neural network", "similarity": "high"},
        {"keyword": "convolutional neural network", "similarity": "medium"},
        {"keyword": "reinforcement learning", "similarity": "medium"},
        {"keyword": "natural language processing", "similarity": "low"},
    ]

    try:
        # Create test keywords
        logger.info("Creating test keywords...")
        for kw_data in test_keywords:
            # Generate vector based on similarity level
            if kw_data["similarity"] == "high":
                vector = generate_similar_vector(base_vector, noise_level=0.05)
            elif kw_data["similarity"] == "medium":
                vector = generate_similar_vector(base_vector, noise_level=0.15)
            else:
                vector = generate_random_vector()  # Completely dissimilar

            await repo.create_and_save_keyword(
                keyword=kw_data["keyword"],
                keyword_type=test_type,
                vector=vector,
                vector_model=test_model,
            )

        await repo.flush()
        await repo.load()
        await asyncio.sleep(2)
        logger.info("✅ Created %d test keywords", len(test_keywords))

        # Test 1: Basic vector search
        logger.info("\nTest 1: Basic vector search (Top 3)")
        results = await repo.search_similar_keywords(
            query_vector=base_vector, keyword_type=test_type, limit=3
        )

        assert len(results) >= 2, f"At least 2 similar keywords should be found, actually found {len(results)}"
        logger.info("Found %d similar keywords:", len(results))
        for i, result in enumerate(results, 1):
            logger.info("  %d. %s (score: %.4f)", i, result["keyword"], result["score"])

        # Verify top results should include high similarity keywords
        top_keywords = [r["keyword"] for r in results[:2]]
        high_similarity_keywords = [
            kw["keyword"] for kw in test_keywords if kw["similarity"] == "high"
        ]
        assert any(
            kw in top_keywords for kw in high_similarity_keywords
        ), "Top results should include high similarity keywords"
        logger.info("✅ Basic vector search test passed")

        # Test 2: Return all results
        logger.info("\nTest 2: Return all results")
        all_results = await repo.search_similar_keywords(
            query_vector=base_vector, keyword_type=test_type, limit=100
        )

        assert len(all_results) == len(
            test_keywords
        ), f"All {len(test_keywords)} keywords should be found, actually found {len(all_results)}"
        logger.info("✅ Found all %d keywords", len(all_results))

    except Exception as e:
        logger.error("❌ Vector similarity search test failed: %s", e)
        raise
    finally:
        # Clean up test data
        logger.info("\nCleaning up test data...")
        try:
            delete_count = await repo.delete_by_type(test_type)
            await repo.flush()
            logger.info("✅ Cleaned up %d test data entries", delete_count)
        except Exception as cleanup_error:
            logger.error("Error during cleanup: %s", cleanup_error)

    logger.info("✅ Vector similarity search test completed\n")


async def test_type_filtering():
    """Test type-based filtering"""
    logger.info("========== Starting type-based filtering test ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    base_vector = generate_random_vector()
    test_model = "bge-m3"

    # Prepare test data with different types
    test_data = [
        {"keyword": "Python", "type": "programming_language"},
        {"keyword": "JavaScript", "type": "programming_language"},
        {"keyword": "React", "type": "framework"},
        {"keyword": "Django", "type": "framework"},
        {"keyword": "MySQL", "type": "database"},
        {"keyword": "PostgreSQL", "type": "database"},
    ]

    try:
        # Create test data
        logger.info("Creating test keywords with different types...")
        for data in test_data:
            vector = generate_similar_vector(base_vector, noise_level=0.1)
            await repo.create_and_save_keyword(
                keyword=data["keyword"],
                keyword_type=data["type"],
                vector=vector,
                vector_model=test_model,
            )

        await repo.flush()
        await repo.load()
        await asyncio.sleep(2)
        logger.info("✅ Created %d keywords with different types", len(test_data))

        # Test 1: Search specific type
        logger.info("\nTest 1: Search programming_language type")
        pl_results = await repo.search_similar_keywords(
            query_vector=base_vector, keyword_type="programming_language", limit=10
        )

        assert len(pl_results) == 2, f"2 programming languages should be found, actually found {len(pl_results)}"
        for result in pl_results:
            assert result["type"] == "programming_language"
            logger.info("  - %s (type: %s)", result["keyword"], result["type"])
        logger.info("✅ Programming language type filtering successful")

        # Test 2: Search another type
        logger.info("\nTest 2: Search framework type")
        fw_results = await repo.search_similar_keywords(
            query_vector=base_vector, keyword_type="framework", limit=10
        )

        assert len(fw_results) == 2, f"2 frameworks should be found, actually found {len(fw_results)}"
        for result in fw_results:
            assert result["type"] == "framework"
            logger.info("  - %s (type: %s)", result["keyword"], result["type"])
        logger.info("✅ Framework type filtering successful")

        # Test 3: Search without specifying type (search all)
        logger.info("\nTest 3: Search without type (search all)")
        all_results = await repo.search_similar_keywords(
            query_vector=base_vector, keyword_type=None, limit=10
        )

        assert (
            len(all_results) >= 6
        ), f"At least 6 keywords should be found, actually found {len(all_results)}"
        logger.info("Found %d keywords (all types)", len(all_results))

        # Count by type
        type_counts = {}
        for result in all_results:
            result_type = result["type"]
            type_counts[result_type] = type_counts.get(result_type, 0) + 1

        logger.info("Type distribution:")
        for kw_type, count in type_counts.items():
            logger.info("  - %s: %d", kw_type, count)
        logger.info("✅ All-type search successful")

        # Test 4: List all keywords of a specific type
        logger.info("\nTest 4: List all keywords of database type")
        db_keywords = await repo.list_keywords_by_type("database")

        assert (
            len(db_keywords) == 2
        ), f"2 database keywords should exist, actually found {len(db_keywords)}"
        for kw in db_keywords:
            logger.info("  - %s", kw["keyword"])
        logger.info("✅ Listing type keywords successful")

    except Exception as e:
        logger.error("❌ Type-based filtering test failed: %s", e)
        raise
    finally:
        # Clean up test data
        logger.info("\nCleaning up test data...")
        try:
            for kw_type in ["programming_language", "framework", "database"]:
                count = await repo.delete_by_type(kw_type)
                logger.info("  Cleaned up %s: %d entries", kw_type, count)
            await repo.flush()
            logger.info("✅ Test data cleanup completed")
        except Exception as cleanup_error:
            logger.error("Error during cleanup: %s", cleanup_error)

    logger.info("✅ Type-based filtering test completed\n")


async def test_batch_operations():
    """Test batch operations"""
    logger.info("========== Starting batch operations test ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    test_type = "batch_test"
    test_model = "bge-m3"

    # Prepare batch test data
    batch_size = 50
    keywords_data = []

    for i in range(batch_size):
        keywords_data.append(
            {
                "keyword": f"keyword_{i}",
                "type": test_type,
                "vector": generate_random_vector(),
                "vector_model": test_model,
            }
        )

    try:
        # Test batch creation
        logger.info("Testing batch creation of %d keywords...", batch_size)
        count = await repo.batch_create_keywords(keywords_data)

        assert (
            count == batch_size
        ), f"{batch_size} keywords should be created, actually created {count}"
        logger.info("✅ Batch creation successful: %d keywords", count)

        # Refresh and verify
        await repo.flush()
        await asyncio.sleep(1)

        # Verify data is saved
        logger.info("Verifying batch data...")
        all_keywords = await repo.list_keywords_by_type(test_type)
        assert (
            len(all_keywords) >= batch_size
        ), f"At least {batch_size} keywords should exist, actually found {len(all_keywords)}"
        logger.info("✅ Data verification successful: found %d keywords", len(all_keywords))

        # Test batch deletion
        logger.info("Testing batch deletion...")
        delete_count = await repo.delete_by_type(test_type)
        assert (
            delete_count >= batch_size
        ), f"At least {batch_size} keywords should be deleted, actually deleted {delete_count}"
        logger.info("✅ Batch deletion successful: %d keywords", delete_count)

        # Verify deletion
        await repo.flush()
        await asyncio.sleep(1)
        remaining = await repo.list_keywords_by_type(test_type)
        assert (
            len(remaining) == 0
        ), f"No data should remain after deletion, actually found {len(remaining)}"
        logger.info("✅ Deletion verification successful")

    except Exception as e:
        logger.error("❌ Batch operations test failed: %s", e)
        raise
    finally:
        # Ensure cleanup
        try:
            await repo.delete_by_type(test_type)
            await repo.flush()
        except Exception:
            pass

    logger.info("✅ Batch operations test completed\n")


async def test_edge_cases():
    """Test edge cases"""
    logger.info("========== Starting edge cases test ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    test_type = "edge_test"
    test_model = "bge-m3"

    try:
        # Test 1: Empty keyword
        logger.info("Test 1: Empty keyword handling")
        try:
            await repo.create_and_save_keyword(
                keyword="",
                keyword_type=test_type,
                vector=generate_random_vector(),
                vector_model=test_model,
            )
            logger.info("⚠️  Empty keyword is allowed to be created")
        except Exception as e:
            logger.info("✅ Empty keyword correctly rejected: %s", e)

        # Test 2: Query non-existent keyword
        logger.info("\nTest 2: Query non-existent keyword")
        nonexistent = await repo.get_keyword_by_text(
            keyword="this_keyword_definitely_does_not_exist_12345", keyword_type=test_type
        )
        assert nonexistent is None, "Non-existent keyword should return None"
        logger.info("✅ Non-existent keyword handled correctly")

        # Test 3: Delete non-existent keyword
        logger.info("\nTest 3: Delete non-existent keyword")
        delete_result = await repo.delete_by_keyword_id("nonexistent_id_99999")
        assert delete_result is True  # Milvus delete returns True even for non-existent ID
        logger.info("✅ Deleting non-existent keyword does not raise error")

        # Test 4: Incorrect vector dimension
        logger.info("\nTest 4: Incorrect vector dimension")
        try:
            await repo.create_and_save_keyword(
                keyword="dimension_error_test",
                keyword_type=test_type,
                vector=[1.0] * 512,  # Incorrect dimension
                vector_model=test_model,
            )
            assert False, "Should fail due to vector dimension error"
        except Exception as e:
            assert "512" in str(e) and "1024" in str(e), "Error message should contain dimension information"
            logger.info("✅ Vector dimension error correctly caught: %s", str(e)[:100])

        # Test 5: Search with empty type (non-existent type)
        logger.info("\nTest 5: Search with empty type (non-existent type)")
        empty_results = await repo.search_similar_keywords(
            query_vector=generate_random_vector(),
            keyword_type="this_type_does_not_exist_99999",
            limit=10,
        )
        assert len(empty_results) == 0, "Non-existent type should return empty results"
        logger.info("✅ Empty type search returns empty results")

        # Test 6: Duplicate keywords (same keyword and type)
        logger.info("\nTest 6: Duplicate keywords")
        duplicate_keyword = "duplicate_test_keyword"

        # Create first
        await repo.create_and_save_keyword(
            keyword=duplicate_keyword,
            keyword_type=test_type,
            vector=generate_random_vector(),
            vector_model=test_model,
        )

        # Try to create duplicate
        try:
            await repo.create_and_save_keyword(
                keyword=duplicate_keyword,
                keyword_type=test_type,
                vector=generate_random_vector(),
                vector_model=test_model,
            )
            logger.info("⚠️  Duplicate keyword is allowed to be created (same ID will be overwritten)")
        except Exception as e:
            logger.info("✅ Duplicate keyword correctly rejected: %s", e)

        await repo.flush()

    except Exception as e:
        logger.error("❌ Edge cases test failed: %s", e)
        raise
    finally:
        # Clean up test data
        try:
            await repo.delete_by_type(test_type)
            await repo.flush()
            logger.info("✅ Edge test data cleanup completed")
        except Exception:
            pass

    logger.info("✅ Edge cases test completed\n")


async def test_real_world_scenario():
    """Test real-world scenario: skill vocabulary"""
    logger.info("========== Starting real-world scenario test: skill vocabulary ==========")

    repo = get_bean_by_type(KeywordVocabularyMilvusRepository)
    test_model = "bge-m3"

    # Simulate real skill vocabulary
    skills_data = {
        "programming": [
            "Python programming",
            "Java development",
            "C++ programming",
            "JavaScript development",
            "Go language",
            "Rust programming",
            "TypeScript development",
        ],
        "framework": [
            "React framework",
            "Vue.js",
            "Django",
            "Spring Boot",
            "FastAPI",
            "Flask",
            "Express.js",
        ],
        "database": [
            "MySQL database",
            "PostgreSQL",
            "MongoDB",
            "Redis cache",
            "Elasticsearch",
            "Cassandra",
        ],
        "devops": [
            "Docker container",
            "Kubernetes",
            "Jenkins",
            "GitLab CI",
            "Terraform",
            "Ansible",
        ],
        "ai_ml": [
            "machine learning",
            "deep learning",
            "natural language processing",
            "computer vision",
            "PyTorch",
            "TensorFlow",
            "scikit-learn",
        ],
    }

    # Create a base vector for each skill category (skills in same category are more similar)
    category_base_vectors = {
        category: generate_random_vector() for category in skills_data.keys()
    }

    try:
        # Create skill vocabulary
        logger.info("Creating skill vocabulary...")
        total_skills = 0

        for category, skills in skills_data.items():
            base_vec = category_base_vectors[category]

            for skill in skills:
                # Skills in same category use similar vectors
                vector = generate_similar_vector(base_vec, noise_level=0.08)

                await repo.create_and_save_keyword(
                    keyword=skill,
                    keyword_type=category,
                    vector=vector,
                    vector_model=test_model,
                )
                total_skills += 1

        await repo.flush()
        await repo.load()
        await asyncio.sleep(2)
        logger.info(
            "✅ Created %d skill keywords, divided into %d categories", total_skills, len(skills_data)
        )

        # Scenario 1: Find similar skills based on known skill
        logger.info("\nScenario 1: Find skills similar to 'Python programming'")
        python_doc = await repo.get_keyword_by_text("Python programming", "programming")
        assert python_doc is not None, "Python programming should be found"

        similar_to_python = await repo.search_similar_keywords(
            query_vector=python_doc["vector"], keyword_type=None, limit=5  # No type restriction
        )

        logger.info("Top 5 skills similar to 'Python programming':")
        for i, result in enumerate(similar_to_python, 1):
            logger.info(
                "  %d. %s [%s] (score: %.4f)",
                i,
                result["keyword"],
                result["type"],
                result["score"],
            )

        # Verify: Top results should mainly be programming category
        top_3_types = [r["type"] for r in similar_to_python[:3]]
        programming_count = sum(1 for t in top_3_types if t == "programming")
        assert programming_count >= 1, "Top 3 should include at least 1 programming skill"
        logger.info("✅ Similar skills search meets expectations")

        # Scenario 2: Find similar skills within a category
        logger.info("\nScenario 2: Find skills similar to a vector within 'ai_ml' category")
        ai_base_vec = category_base_vectors["ai_ml"]
        query_vec = generate_similar_vector(ai_base_vec, noise_level=0.05)

        ai_results = await repo.search_similar_keywords(
            query_vector=query_vec, keyword_type="ai_ml", limit=3
        )

        logger.info("Top 3 skills most similar in AI/ML category:")
        for i, result in enumerate(ai_results, 1):
            logger.info("  %d. %s (score: %.4f)", i, result["keyword"], result["score"])

        assert len(ai_results) >= 3, "At least 3 AI/ML skills should be found"
        logger.info("✅ Category-filtered search successful")

        # Scenario 3: List all skills in a category
        logger.info("\nScenario 3: List all skills in 'database' category")
        db_skills = await repo.list_keywords_by_type("database")

        logger.info("Database category skills (total %d):", len(db_skills))
        for skill in db_skills:
            logger.info("  - %s", skill["keyword"])

        expected_count = len(skills_data["database"])
        assert (
            len(db_skills) == expected_count
        ), f"{expected_count} database skills should exist, actually found {len(db_skills)}"
        logger.info("✅ Category list query successful")

        # Scenario 4: Cross-category search
        logger.info("\nScenario 4: Cross-category search (find all skills related to development)")
        dev_query_vec = category_base_vectors["programming"]

        all_related = await repo.search_similar_keywords(
            query_vector=dev_query_vec, keyword_type=None, limit=10
        )

        logger.info("Top 10 skills most related to development (cross-category):")
        for i, result in enumerate(all_related, 1):
            logger.info(
                "  %d. %s [%s] (score: %.4f)",
                i,
                result["keyword"],
                result["type"],
                result["score"],
            )

        assert len(all_related) == 10, "10 results should be returned"
        logger.info("✅ Cross-category search successful")

        # Scenario 5: Count skills by category
        logger.info("\nScenario 5: Count skills by category")
        category_counts = {}

        for category in skills_data.keys():
            keywords = await repo.list_keywords_by_type(category)
            category_counts[category] = len(keywords)

        logger.info("Skill count by category:")
        for category, count in category_counts.items():
            expected = len(skills_data[category])
            logger.info("  - %s: %d (expected: %d)", category, count, expected)
            assert count == expected, f"{category} category count mismatch"

        logger.info("✅ Statistics verification successful")

    except Exception as e:
        logger.error("❌ Real-world scenario test failed: %s", e)
        raise
    finally:
        # Clean up all test data
        logger.info("\nCleaning up all skill data...")
        try:
            total_deleted = 0
            for category in skills_data.keys():
                count = await repo.delete_by_type(category)
                total_deleted += count
                logger.info("  Cleaned up %s: %d entries", category, count)
            await repo.flush()
            logger.info("✅ Total cleaned up %d entries", total_deleted)
        except Exception as cleanup_error:
            logger.error("Error during cleanup: %s", cleanup_error)

    logger.info("✅ Real-world scenario test completed\n")


async def run_all_tests():
    """Run all tests"""
    logger.info("=" * 60)
    logger.info("🚀 Starting all tests for KeywordVocabularyMilvusRepository")
    logger.info("=" * 60 + "\n")

    try:
        await test_basic_crud_operations()
        await test_vector_similarity_search()
        await test_type_filtering()
        await test_batch_operations()
        await test_edge_cases()
        await test_real_world_scenario()

        logger.info("=" * 60)
        logger.info("✅ All tests completed!")
        logger.info("=" * 60)

    except Exception as e:
        logger.error("=" * 60)
        logger.error("❌ Error during testing: %s", e)
        logger.error("=" * 60)
        raise


if __name__ == "__main__":
    asyncio.run(run_all_tests())