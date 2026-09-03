IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50000, 'The dbo.tree_node_details table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_detail_files', 'U') IS NULL
BEGIN
  THROW 50001, 'The dbo.tree_node_detail_files table does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_node_details', 'updated_by_object_id') IS NULL
BEGIN
  THROW 50002, 'The dbo.tree_node_details.updated_by_object_id column does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_node_details', 'updated_by_user_details') IS NULL
BEGIN
  THROW 50003, 'The dbo.tree_node_details.updated_by_user_details column does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'updated_by_object_id') IS NULL
BEGIN
  THROW 50004, 'The dbo.tree_node_detail_files.updated_by_object_id column does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'updated_by_user_details') IS NULL
BEGIN
  THROW 50005, 'The dbo.tree_node_detail_files.updated_by_user_details column does not exist.', 1;
END;

DECLARE @updated_by_object_id NVARCHAR(100) = N'9dd8fd64-44a8-4560-80e7-0ef65374745c';
DECLARE @updated_by_user_details NVARCHAR(320) = N'testuser1@altskavaek.onmicrosoft.com';

UPDATE dbo.tree_node_details
SET updated_by_object_id = @updated_by_object_id,
    updated_by_user_details = @updated_by_user_details;

UPDATE dbo.tree_node_detail_files
SET updated_by_object_id = @updated_by_object_id,
    updated_by_user_details = @updated_by_user_details;